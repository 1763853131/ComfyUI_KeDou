# Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved
"""Model architecture modified from DETR for OmniShotCut."""
import torch
import torch.nn.functional as F
from torch import nn

from ..util import NestedTensor, nested_tensor_from_tensor_list
from .backbone import build_backbone
from .transformer import build_transformer


class MLP(nn.Module):
    def __init__(self, input_dim, hidden_dim, output_dim, num_layers):
        super().__init__()
        self.num_layers = num_layers
        hidden = [hidden_dim] * (num_layers - 1)
        self.layers = nn.ModuleList(nn.Linear(n, k)
                                    for n, k in zip([input_dim] + hidden, hidden + [output_dim]))

    def forward(self, x):
        for index, layer in enumerate(self.layers):
            x = F.relu(layer(x)) if index < self.num_layers - 1 else layer(x)
        return x


class OmniShotCut(nn.Module):
    def __init__(self, backbone, transformer, num_intra_relation_classes,
                 num_inter_relation_classes, num_frames, num_queries, aux_loss=False):
        super().__init__()
        self.num_queries = num_queries
        self.num_frames = num_frames
        self.aux_loss = aux_loss
        self.backbone = backbone
        self.transformer = transformer
        hidden_dim = transformer.d_model
        self.intra_relation_class_embed = nn.Linear(hidden_dim, num_intra_relation_classes)
        self.inter_relation_class_embed = nn.Linear(hidden_dim, num_inter_relation_classes)
        self.range_class_embed = nn.Linear(hidden_dim, num_frames + 2)
        self.query_embed = nn.Embedding(num_queries, hidden_dim)
        self.input_proj = nn.Conv2d(backbone.num_channels, hidden_dim, kernel_size=1)

    def forward(self, samples):
        if isinstance(samples, (list, torch.Tensor)):
            samples = nested_tensor_from_tensor_list(samples)
        if not isinstance(samples, NestedTensor) or samples.mask is None:
            raise ValueError("OmniShotCut expects a NestedTensor with a mask")
        features, pos = self.backbone(samples)
        pos = pos[-1]
        src, mask = features[-1].decompose()
        src_proj = self.input_proj(src)
        n, c, h, w = src_proj.shape
        if n % self.num_frames:
            raise ValueError("Backbone frame count does not match the model window")
        src_proj = src_proj.reshape(n // self.num_frames, self.num_frames, c, h, w)
        src_proj = src_proj.permute(0, 2, 1, 3, 4).flatten(-2)
        mask = mask.reshape(n // self.num_frames, self.num_frames, h * w)
        pos = pos.permute(0, 2, 1, 3, 4).flatten(-2)
        hs = self.transformer(src_proj, mask, self.query_embed.weight, pos)[0]
        outputs_intra = self.intra_relation_class_embed(hs)
        outputs_inter = self.inter_relation_class_embed(hs)
        outputs_range = self.range_class_embed(hs)
        out = {"intra_clip_logits": outputs_intra[-1],
               "inter_clip_logits": outputs_inter[-1],
               "pred_shot_logits": outputs_range[-1]}
        if self.aux_loss:
            out["aux_outputs"] = [
                {"intra_clip_logits": a, "inter_clip_logits": b, "pred_shot_logits": c}
                for a, b, c in zip(outputs_intra[:-1], outputs_inter[:-1], outputs_range[:-1])]
        return out


def build_model(args):
    return OmniShotCut(build_backbone(args), build_transformer(args),
                       num_intra_relation_classes=args.num_intra_relation_classes,
                       num_inter_relation_classes=args.num_inter_relation_classes,
                       num_frames=args.max_process_window_length,
                       num_queries=args.num_queries, aux_loss=args.aux_loss)
