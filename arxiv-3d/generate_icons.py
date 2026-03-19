#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
generate_icons.py — Generate icon images from prompts using Stable Diffusion XL.

Reads icon_prompts.json and generates multiple candidate images per category
using SDXL on a local NVIDIA GPU. Generates 4 candidates per category so you
can manually pick the best one.

Usage:
  python generate_icons.py                          # generate all
  python generate_icons.py --categories atlas-detector cms-detector  # specific ones
  python generate_icons.py --candidates 2           # 2 candidates per category
  python generate_icons.py --resume                 # skip already generated

Requirements:
  pip install diffusers transformers accelerate torch
  NVIDIA GPU with 8GB+ VRAM
"""

import argparse
import json
import os
from pathlib import Path

# Output directory
ICONS_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..", "arxiv-3d-frontend", "public", "icons", "categories"
)

PROMPTS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icon_prompts.json")

# Style suffix appended to every prompt for consistency
STYLE_SUFFIX = ", scientific illustration, clean vector art style, white background, no text, no labels, high detail, sharp lines"

NEGATIVE_PROMPT = "text, words, letters, numbers, equations, labels, annotations, blurry, low quality, photo, photorealistic, watermark, signature, border, frame"


def load_prompts(specific_categories=None):
    if not os.path.exists(PROMPTS_PATH):
        raise FileNotFoundError(f"Prompts file not found: {PROMPTS_PATH}\nRun generate_icon_prompts.py first.")

    with open(PROMPTS_PATH, 'r') as f:
        all_prompts = json.load(f)

    if specific_categories:
        return {k: v for k, v in all_prompts.items() if k in specific_categories}
    return all_prompts


def get_existing_categories(icons_dir):
    """Check which categories already have at least one generated image."""
    existing = set()
    if os.path.exists(icons_dir):
        for f in os.listdir(icons_dir):
            # Files are named like "atlas-detector_0.png"
            if '_' in f and f.endswith('.png'):
                cat = f.rsplit('_', 1)[0]
                existing.add(cat)
    return existing


def run(specific_categories=None, num_candidates=4, resume=False):
    prompts = load_prompts(specific_categories)
    print(f"[info] Loaded {len(prompts)} category prompts")

    # Create output directory
    os.makedirs(ICONS_DIR, exist_ok=True)

    if resume:
        existing = get_existing_categories(ICONS_DIR)
        prompts = {k: v for k, v in prompts.items() if k not in existing}
        print(f"[info] {len(prompts)} remaining after skipping existing")

    if not prompts:
        print("[info] Nothing to generate.")
        return

    # Import and initialize pipeline (lazy to avoid slow imports if nothing to do)
    print("[info] Loading Stable Diffusion XL pipeline...")
    import torch
    from diffusers import StableDiffusionXLPipeline

    pipe = StableDiffusionXLPipeline.from_pretrained(
        "stabilityai/stable-diffusion-xl-base-1.0",
        torch_dtype=torch.float16,
        use_safetensors=True,
        variant="fp16"
    )

    # Use sequential CPU offload for 6GB VRAM GPUs
    pipe.enable_sequential_cpu_offload()
    pipe.enable_vae_slicing()
    pipe.enable_attention_slicing()
    print("[info] Sequential CPU offload + attention slicing enabled (6GB VRAM mode)")

    total = len(prompts)
    for i, (category, data) in enumerate(prompts.items()):
        prompt_text = data["prompt"] + STYLE_SUFFIX
        print(f"\n[{i+1}/{total}] Generating {num_candidates} candidates for: {category}")
        print(f"  Prompt: {prompt_text[:100]}...")

        try:
            images = pipe(
                prompt=prompt_text,
                negative_prompt=NEGATIVE_PROMPT,
                width=512,
                height=512,
                num_images_per_prompt=num_candidates,
                num_inference_steps=30,
                guidance_scale=7.5,
            ).images

            for j, img in enumerate(images):
                out_path = os.path.join(ICONS_DIR, f"{category}_{j}.png")
                img.save(out_path)
                print(f"  ✓ Saved: {category}_{j}.png")

        except Exception as e:
            print(f"  ERROR generating {category}: {e}")
            continue

    print(f"\n[done] Generated icons in: {ICONS_DIR}")
    print("Review the candidates and rename the best one to '{category}.png' (removing the _N suffix).")
    print("Delete the rejected candidates.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generate icon images with Stable Diffusion XL.")
    parser.add_argument(
        "--categories", nargs="+",
        help="Only generate for these specific categories"
    )
    parser.add_argument(
        "--candidates", type=int, default=4,
        help="Number of candidate images per category (default: 4)"
    )
    parser.add_argument(
        "--resume", action="store_true",
        help="Skip categories that already have generated images"
    )
    args = parser.parse_args()
    run(specific_categories=args.categories, num_candidates=args.candidates, resume=args.resume)
