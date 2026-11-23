/**
 * workflows-default.js —— 首次打开时内置的工作流
 *
 * 就是 C:/Users/wangy/Downloads/MOSS文生图-api.json 原文（API 导出格式）。
 * MOSS 构成：UNETLoader(Moss\miaomiaoHaremMOSS_baseV10_fp16) + CLIPLoader(qwen3.5_9b_heretic, type=moss_image)
 *           + 双 LoraLoader 链 + KSampler(8 步 / cfg 1 / euler / simple) + EmptyLatentImage 1080x1920
 *           负面走 ConditioningZeroOut（等于不用负面词）
 */

export const DEFAULT_WORKFLOW_NAME = 'MOSS 文生图';

export const DEFAULT_WORKFLOW_JSON = String.raw`{
  "2": {
    "inputs": {
      "seed": 666,
      "steps": 8,
      "cfg": 1,
      "sampler_name": "euler",
      "scheduler": "simple",
      "denoise": 1,
      "model": [
        "37",
        0
      ],
      "positive": [
        "5",
        0
      ],
      "negative": [
        "9",
        0
      ],
      "latent_image": [
        "3",
        0
      ]
    },
    "class_type": "KSampler",
    "_meta": {
      "title": "K采样器",
      "cnr_id": "comfy-core",
      "ver": "0.41.0"
    }
  },
  "3": {
    "inputs": {
      "width": 1080,
      "height": 1920,
      "batch_size": 1
    },
    "class_type": "EmptyLatentImage",
    "_meta": {
      "title": "空Latent图像",
      "cnr_id": "comfy-core",
      "ver": "0.41.0"
    }
  },
  "5": {
    "inputs": {
      "text": "1girl，fullybody,bikini",
      "clip": [
        "37",
        1
      ]
    },
    "class_type": "CLIPTextEncode",
    "_meta": {
      "title": "提示词",
      "cnr_id": "comfy-core",
      "ver": "0.41.0"
    }
  },
  "6": {
    "inputs": {
      "samples": [
        "2",
        0
      ],
      "vae": [
        "7",
        0
      ]
    },
    "class_type": "VAEDecode",
    "_meta": {
      "title": "VAE解码",
      "cnr_id": "comfy-core",
      "ver": "0.41.0"
    }
  },
  "7": {
    "inputs": {
      "vae_name": "flux2-vae.safetensors"
    },
    "class_type": "VAELoader",
    "_meta": {
      "title": "加载VAE",
      "cnr_id": "comfy-core",
      "ver": "0.41.0"
    }
  },
  "9": {
    "inputs": {
      "conditioning": [
        "5",
        0
      ]
    },
    "class_type": "ConditioningZeroOut",
    "_meta": {
      "title": "条件零化"
    }
  },
  "11": {
    "inputs": {
      "unet_name": "Moss\\miaomiaoHaremMOSS_baseV10_fp16.safetensors",
      "weight_dtype": "default"
    },
    "class_type": "UNETLoader",
    "_meta": {
      "title": "UNet加载器",
      "cnr_id": "comfy-core",
      "ver": "0.41.0"
    }
  },
  "12": {
    "inputs": {
      "clip_name": "Moss\\qwen3.5_9b_heretic_int8_convrot.safetensors",
      "type": "moss_image",
      "device": "default"
    },
    "class_type": "CLIPLoader",
    "_meta": {
      "title": "加载CLIP",
      "cnr_id": "comfy-core",
      "ver": "0.41.0"
    }
  },
  "13": {
    "inputs": {
      "filename_prefix": "VR2-20261120165408",
      "images": [
        "6",
        0
      ]
    },
    "class_type": "SaveImage",
    "_meta": {
      "title": "保存图像",
      "cnr_id": "comfy-core",
      "ver": "0.41.0"
    }
  },
  "36": {
    "inputs": {
      "lora_name": "Moss\\很好的工作流lora\\lora_latest.safetensors",
      "strength_model": 1,
      "strength_clip": 1,
      "model": [
        "11",
        0
      ],
      "clip": [
        "12",
        0
      ]
    },
    "class_type": "LoraLoader",
    "_meta": {
      "title": "加载LoRA"
    }
  },
  "37": {
    "inputs": {
      "lora_name": "Moss\\style\\SKP_mossv2.safetensors",
      "strength_model": 1,
      "strength_clip": 1,
      "model": [
        "36",
        0
      ],
      "clip": [
        "36",
        1
      ]
    },
    "class_type": "LoraLoader",
    "_meta": {
      "title": "加载LoRA"
    }
  }
}`;
