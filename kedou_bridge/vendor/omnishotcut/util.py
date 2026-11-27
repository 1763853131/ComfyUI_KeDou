# Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved
"""NestedTensor and the exact DETR/VisTR video collation used by OmniShotCut."""
from typing import Optional, List

import torch
from torch import Tensor


class NestedTensor:
    def __init__(self, tensors: Tensor, mask: Optional[Tensor]):
        self.tensors = tensors
        self.mask = mask

    def to(self, device):
        return NestedTensor(self.tensors.to(device),
                            self.mask.to(device) if self.mask is not None else None)

    def decompose(self):
        return self.tensors, self.mask


def _max_by_axis(the_list):
    maxes = list(the_list[0])
    for sublist in the_list[1:]:
        for index, item in enumerate(sublist):
            maxes[index] = max(maxes[index], item)
    return maxes


def nested_tensor_from_tensor_list(tensor_list: List[Tensor], split=True):
    if split:
        tensor_list = [item for sublist in tensor_list for item in sublist]
    if not tensor_list or tensor_list[0].ndim != 3:
        raise ValueError("OmniShotCut input must contain non-empty CxHxW frames")
    batch_shape = [len(tensor_list)] + _max_by_axis([list(img.shape) for img in tensor_list])
    tensor = torch.zeros(batch_shape, dtype=tensor_list[0].dtype, device=tensor_list[0].device)
    mask = torch.ones((len(tensor_list), batch_shape[2], batch_shape[3]),
                      dtype=torch.bool, device=tensor_list[0].device)
    for img, pad_img, item_mask in zip(tensor_list, tensor, mask):
        pad_img[:img.shape[0], :img.shape[1], :img.shape[2]].copy_(img)
        item_mask[:img.shape[1], :img.shape[2]] = False
    return NestedTensor(tensor, mask)
