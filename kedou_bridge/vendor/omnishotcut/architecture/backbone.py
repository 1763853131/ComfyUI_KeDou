# Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved
"""ResNet18 DETR backbone; checkpoint weights are loaded by the caller."""
from typing import Dict, List
import torch
import torch.nn.functional as F
import torchvision
from torch import nn
from torchvision.models._utils import IntermediateLayerGetter

from ..util import NestedTensor
from .position_encoding import build_position_encoding


class FrozenBatchNorm2d(nn.Module):
    def __init__(self, n):
        super().__init__()
        self.register_buffer("weight", torch.ones(n))
        self.register_buffer("bias", torch.zeros(n))
        self.register_buffer("running_mean", torch.zeros(n))
        self.register_buffer("running_var", torch.ones(n))

    def _load_from_state_dict(self, state_dict, prefix, local_metadata, strict,
                              missing_keys, unexpected_keys, error_msgs):
        key = prefix + "num_batches_tracked"
        if key in state_dict:
            del state_dict[key]
        super()._load_from_state_dict(state_dict, prefix, local_metadata, strict,
                                      missing_keys, unexpected_keys, error_msgs)

    def forward(self, x):
        scale = self.weight.reshape(1, -1, 1, 1) * (self.running_var.reshape(1, -1, 1, 1) + 1e-5).rsqrt()
        bias = self.bias.reshape(1, -1, 1, 1) - self.running_mean.reshape(1, -1, 1, 1) * scale
        return x * scale + bias


class BackboneBase(nn.Module):
    def __init__(self, backbone, train_backbone, num_channels, return_interm_layers):
        super().__init__()
        return_layers = ({"layer1": "0", "layer2": "1", "layer3": "2", "layer4": "3"}
                         if return_interm_layers else {"layer4": "0"})
        self.body = IntermediateLayerGetter(backbone, return_layers=return_layers)
        self.num_channels = num_channels

    def forward(self, tensor_list):
        xs = self.body(tensor_list.tensors)
        out = {}
        for name, x in xs.items():
            if tensor_list.mask is None:
                raise ValueError("OmniShotCut requires a padding mask")
            mask = F.interpolate(tensor_list.mask[None].float(), size=x.shape[-2:]).bool()[0]
            out[name] = NestedTensor(x, mask)
        return out


class Backbone(BackboneBase):
    def __init__(self, name, train_backbone, return_interm_layers, dilation):
        constructor = getattr(torchvision.models, name)
        try:
            backbone = constructor(replace_stride_with_dilation=[False, False, dilation],
                                   weights=None, norm_layer=FrozenBatchNorm2d)
        except TypeError:  # torchvision versions predating the weights= API
            backbone = constructor(replace_stride_with_dilation=[False, False, dilation],
                                   pretrained=False, norm_layer=FrozenBatchNorm2d)
        num_channels = 512 if name in ("resnet18", "resnet34") else 2048
        super().__init__(backbone, train_backbone, num_channels, return_interm_layers)


class Joiner(nn.Sequential):
    def __init__(self, backbone, position_embedding):
        super().__init__(backbone, position_embedding)

    def forward(self, tensor_list):
        xs = self[0](tensor_list)
        features, positions = [], []
        for value in xs.values():
            features.append(value)
            positions.append(self[1](value).to(value.tensors.dtype))
        return features, positions


def build_backbone(args):
    position_embedding = build_position_encoding(args)
    backbone = Backbone(args.backbone, args.lr_backbone > 0, args.masks, args.dilation)
    model = Joiner(backbone, position_embedding)
    model.num_channels = backbone.num_channels
    return model
