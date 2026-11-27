# -*- coding: utf-8 -*-
"""TransNetV2 inference model adapted from transnetv2-pytorch 1.0.5.

MIT License

Copyright (c) 2020 Tomáš Souček
Copyright (c) 2025 Allen Day

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Only the inference architecture is retained. Video readers, ffmpeg helpers,
CLI code and whole-video frame stacking are intentionally not included.
"""

import os
import random

import torch
import torch.nn as nn
import torch.nn.functional as functional


class TransNetV2(nn.Module):
    """Official TransNetV2 architecture with explicitly supplied weights."""

    def __init__(self,
                 F=16,
                 L=3,
                 S=2,
                 D=1024,
                 use_many_hot_targets=True,
                 use_frame_similarity=True,
                 use_color_histograms=True,
                 use_mean_pooling=False,
                 dropout_rate=0.5,
                 use_convex_comb_reg=False,
                 use_resnet_features=False,
                 use_resnet_like_top=False,
                 frame_similarity_on_last_layer=False,
                 device="auto",
                 weights_path=None):
        super(TransNetV2, self).__init__()

        if device == "auto":
            device = self._detect_best_device()
        self.device = torch.device(device)
        self._input_size = (27, 48, 3)

        if (use_resnet_features or use_resnet_like_top or use_convex_comb_reg
                or frame_similarity_on_last_layer):
            raise NotImplementedError("Some options are not implemented in the PyTorch version of TransNetV2")

        self.SDDCNN = nn.ModuleList(
            [StackedDDCNNV2(in_filters=3, n_blocks=S, filters=F,
                            stochastic_depth_drop_prob=0.0)]
            + [StackedDDCNNV2(in_filters=(F * 2 ** (i - 1)) * 4,
                              n_blocks=S, filters=F * 2 ** i)
               for i in range(1, L)]
        )

        self.frame_sim_layer = FrameSimilarity(
            sum([(F * 2 ** i) * 4 for i in range(L)]),
            lookup_window=101, output_dim=128, similarity_dim=128, use_bias=True,
        ) if use_frame_similarity else None
        self.color_hist_layer = ColorHistograms(
            lookup_window=101, output_dim=128,
        ) if use_color_histograms else None

        self.dropout = nn.Dropout(dropout_rate) if dropout_rate is not None else None
        # The official default L=3 reduces 27x48 to 3x6. Deriving the
        # spatial size also keeps the exposed F/L constructor options valid.
        output_dim = (((F * 2 ** (L - 1)) * 4)
                      * (27 // (2 ** L)) * (48 // (2 ** L)))
        if use_frame_similarity:
            output_dim += 128
        if use_color_histograms:
            output_dim += 128

        self.fc1 = nn.Linear(output_dim, D)
        self.cls_layer1 = nn.Linear(D, 1)
        self.cls_layer2 = nn.Linear(D, 1) if use_many_hot_targets else None
        self.use_mean_pooling = use_mean_pooling

        if weights_path is not None:
            self.load_pretrained_weights(weights_path)
        self.eval()
        self.to(self.device)

    @staticmethod
    def _detect_best_device():
        """Use CUDA when available, otherwise CPU (no MPS numerical fallback)."""
        return "cuda" if torch.cuda.is_available() else "cpu"

    def load_pretrained_weights(self, weights_path):
        """Load a verified official weight file onto CPU, then onto the model device."""
        model_path = os.path.abspath(os.fspath(weights_path))
        if not os.path.isfile(model_path):
            raise FileNotFoundError("Model weights not found at %s" % model_path)
        try:
            state_dict = torch.load(model_path, map_location="cpu", weights_only=True)
        except TypeError:  # PyTorch versions before the weights_only argument.
            state_dict = torch.load(model_path, map_location="cpu")
        self.load_state_dict(state_dict)

    def forward(self, inputs):
        """Return single-frame and many-hot logits for uint8 [B,T,27,48,3] input."""
        assert (isinstance(inputs, torch.Tensor)
                and tuple(inputs.shape[2:]) == self._input_size
                and inputs.dtype == torch.uint8), "incorrect input type and/or shape"
        # uint8 [B,T,H,W,3] -> float [B,3,T,H,W].
        x = inputs.permute([0, 4, 1, 2, 3]).float()
        x = x.div_(255.0)

        block_features = []
        for block in self.SDDCNN:
            x = block(x)
            block_features.append(x)

        if self.use_mean_pooling:
            x = torch.mean(x, dim=[3, 4])
            x = x.permute(0, 2, 1)
        else:
            x = x.permute(0, 2, 3, 4, 1)
            x = x.reshape(x.shape[0], x.shape[1], -1)

        if self.frame_sim_layer is not None:
            x = torch.cat([self.frame_sim_layer(block_features), x], 2)
        if self.color_hist_layer is not None:
            x = torch.cat([self.color_hist_layer(inputs), x], 2)

        x = self.fc1(x)
        x = functional.relu(x)
        if self.dropout is not None:
            x = self.dropout(x)
        one_hot = self.cls_layer1(x)
        if self.cls_layer2 is not None:
            return one_hot, {"many_hot": self.cls_layer2(x)}
        return one_hot

    def predict_raw(self, frames):
        """Return sigmoid probabilities for both official prediction heads."""
        assert (isinstance(frames, torch.Tensor) and len(frames.shape) == 5
                and tuple(frames.shape[2:]) == self._input_size), \
            "Input shape must be [batch, frames, height, width, 3]."
        single_frame_pred, all_frames_pred = self.forward(frames)
        return (torch.sigmoid(single_frame_pred),
                torch.sigmoid(all_frames_pred["many_hot"]))


class StackedDDCNNV2(nn.Module):
    def __init__(self,
                 in_filters,
                 n_blocks,
                 filters,
                 shortcut=True,
                 use_octave_conv=False,
                 pool_type="avg",
                 stochastic_depth_drop_prob=0.0):
        super(StackedDDCNNV2, self).__init__()
        if use_octave_conv:
            raise NotImplementedError("Octave convolution is not implemented in the PyTorch version")
        assert pool_type in ("max", "avg")
        if use_octave_conv and pool_type == "max":
            print("WARN: Octave convolution was designed for average pooling, not max pooling.")

        self.shortcut = shortcut
        self.DDCNN = nn.ModuleList([
            DilatedDCNNV2(in_filters if i == 1 else filters * 4, filters,
                          octave_conv=use_octave_conv,
                          activation=functional.relu if i != n_blocks else None)
            for i in range(1, n_blocks + 1)
        ])
        self.pool = (nn.MaxPool3d(kernel_size=(1, 2, 2)) if pool_type == "max"
                     else nn.AvgPool3d(kernel_size=(1, 2, 2)))
        self.stochastic_depth_drop_prob = stochastic_depth_drop_prob

    def forward(self, inputs):
        x = inputs
        shortcut = None
        for block in self.DDCNN:
            x = block(x)
            if shortcut is None:
                shortcut = x
        x = functional.relu(x)
        if self.shortcut is not None:
            if self.stochastic_depth_drop_prob != 0.0:
                if self.training:
                    if random.random() < self.stochastic_depth_drop_prob:
                        x = shortcut
                    else:
                        x = x + shortcut
                else:
                    x = (1 - self.stochastic_depth_drop_prob) * x + shortcut
            else:
                x += shortcut
        return self.pool(x)


class DilatedDCNNV2(nn.Module):
    def __init__(self,
                 in_filters,
                 filters,
                 batch_norm=True,
                 activation=None,
                 octave_conv=False):
        super(DilatedDCNNV2, self).__init__()
        if octave_conv:
            raise NotImplementedError("Octave convolution is not implemented in the PyTorch version")
        assert not (octave_conv and batch_norm)
        self.Conv3D_1 = Conv3DConfigurable(in_filters, filters, 1, use_bias=not batch_norm)
        self.Conv3D_2 = Conv3DConfigurable(in_filters, filters, 2, use_bias=not batch_norm)
        self.Conv3D_4 = Conv3DConfigurable(in_filters, filters, 4, use_bias=not batch_norm)
        self.Conv3D_8 = Conv3DConfigurable(in_filters, filters, 8, use_bias=not batch_norm)
        self.bn = nn.BatchNorm3d(filters * 4, eps=1e-3) if batch_norm else None
        self.activation = activation

    def forward(self, inputs):
        conv1 = self.Conv3D_1(inputs)
        conv2 = self.Conv3D_2(inputs)
        conv3 = self.Conv3D_4(inputs)
        conv4 = self.Conv3D_8(inputs)
        x = torch.cat([conv1, conv2, conv3, conv4], dim=1)
        if self.bn is not None:
            x = self.bn(x)
        if self.activation is not None:
            x = self.activation(x)
        return x


class Conv3DConfigurable(nn.Module):
    def __init__(self,
                 in_filters,
                 filters,
                 dilation_rate,
                 separable=True,
                 octave=False,
                 use_bias=True,
                 kernel_initializer=None):
        super(Conv3DConfigurable, self).__init__()
        if octave:
            raise NotImplementedError("Octave convolution is not implemented in the PyTorch version")
        if kernel_initializer is not None:
            raise NotImplementedError("Kernel initializers are not implemented in the PyTorch version")
        assert not (separable and octave)
        if separable:
            # (2+1)D convolution https://arxiv.org/pdf/1711.11248.pdf
            conv1 = nn.Conv3d(in_filters, 2 * filters, kernel_size=(1, 3, 3),
                              dilation=(1, 1, 1), padding=(0, 1, 1), bias=False)
            conv2 = nn.Conv3d(2 * filters, filters, kernel_size=(3, 1, 1),
                              dilation=(dilation_rate, 1, 1),
                              padding=(dilation_rate, 0, 0), bias=use_bias)
            self.layers = nn.ModuleList([conv1, conv2])
        else:
            conv = nn.Conv3d(in_filters, filters, kernel_size=3,
                             dilation=(dilation_rate, 1, 1),
                             padding=(dilation_rate, 1, 1), bias=use_bias)
            self.layers = nn.ModuleList([conv])

    def forward(self, inputs):
        x = inputs
        for layer in self.layers:
            x = layer(x)
        return x


class FrameSimilarity(nn.Module):
    def __init__(self,
                 in_filters,
                 similarity_dim=128,
                 lookup_window=101,
                 output_dim=128,
                 stop_gradient=False,
                 use_bias=False):
        super(FrameSimilarity, self).__init__()
        if stop_gradient:
            raise NotImplementedError("Stop gradient is not implemented in the PyTorch version")
        self.projection = nn.Linear(in_filters, similarity_dim, bias=use_bias)
        self.fc = nn.Linear(lookup_window, output_dim)
        self.lookup_window = lookup_window
        assert lookup_window % 2 == 1, "`lookup_window` must be odd integer"

    def forward(self, inputs):
        x = torch.cat([torch.mean(x, dim=[3, 4]) for x in inputs], dim=1)
        x = torch.transpose(x, 1, 2)
        x = self.projection(x)
        x = functional.normalize(x, p=2, dim=2)
        batch_size, time_window = x.shape[0], x.shape[1]
        similarities = torch.bmm(x, x.transpose(1, 2))
        similarities_padded = functional.pad(
            similarities, [(self.lookup_window - 1) // 2, (self.lookup_window - 1) // 2])
        batch_indices = torch.arange(0, batch_size, device=x.device).view(
            [batch_size, 1, 1]).repeat([1, time_window, self.lookup_window])
        time_indices = torch.arange(0, time_window, device=x.device).view(
            [1, time_window, 1]).repeat([batch_size, 1, self.lookup_window])
        lookup_indices = torch.arange(0, self.lookup_window, device=x.device).view(
            [1, 1, self.lookup_window]).repeat([batch_size, time_window, 1]) + time_indices
        similarities = similarities_padded[batch_indices, time_indices, lookup_indices]
        return functional.relu(self.fc(similarities))


class ColorHistograms(nn.Module):
    def __init__(self, lookup_window=101, output_dim=None):
        super(ColorHistograms, self).__init__()
        self.fc = nn.Linear(lookup_window, output_dim) if output_dim is not None else None
        self.lookup_window = lookup_window
        assert lookup_window % 2 == 1, "`lookup_window` must be odd integer"

    @staticmethod
    def compute_color_histograms(frames):
        frames = frames.int()

        def get_bin(values):
            # Returns 0 .. 511.
            red, green, blue = values[:, :, 0], values[:, :, 1], values[:, :, 2]
            red, green, blue = red >> 5, green >> 5, blue >> 5
            return (red << 6) + (green << 3) + blue

        batch_size, time_window, height, width, no_channels = frames.shape
        assert no_channels == 3
        frames_flatten = frames.view(batch_size * time_window, height * width, 3)
        binned_values = get_bin(frames_flatten)
        frame_bin_prefix = (torch.arange(0, batch_size * time_window, device=frames.device)
                            << 9).view(-1, 1)
        binned_values = (binned_values + frame_bin_prefix).view(-1)
        histograms = torch.zeros(batch_size * time_window * 512,
                                 dtype=torch.int32, device=frames.device)
        histograms.scatter_add_(0, binned_values,
                                torch.ones(len(binned_values), dtype=torch.int32,
                                           device=frames.device))
        histograms = histograms.view(batch_size, time_window, 512).float()
        return functional.normalize(histograms, p=2, dim=2)

    def forward(self, inputs):
        x = self.compute_color_histograms(inputs)
        batch_size, time_window = x.shape[0], x.shape[1]
        similarities = torch.bmm(x, x.transpose(1, 2))
        similarities_padded = functional.pad(
            similarities, [(self.lookup_window - 1) // 2, (self.lookup_window - 1) // 2])
        batch_indices = torch.arange(0, batch_size, device=x.device).view(
            [batch_size, 1, 1]).repeat([batch_size, time_window, self.lookup_window])
        time_indices = torch.arange(0, time_window, device=x.device).view(
            [1, time_window, 1]).repeat([batch_size, 1, self.lookup_window])
        lookup_indices = torch.arange(0, self.lookup_window, device=x.device).view(
            [1, 1, self.lookup_window]).repeat([batch_size, time_window, 1]) + time_indices
        similarities = similarities_padded[batch_indices, time_indices, lookup_indices]
        if self.fc is not None:
            return functional.relu(self.fc(similarities))
        return similarities
