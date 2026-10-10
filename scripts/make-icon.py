#!/usr/bin/env python3
"""
把一张方形的图标源图摆到 macOS 的图标网格上，并生成 build/icon.icns 和 build/icon.png。

为什么需要这一步：很多图标的画布是**画满**的 —— 圆角方块的四条边直接顶到图像边缘。
macOS 的图标网格不是这样：1024×1024 的画布里，图形只占中间 824×824，四周各留 100px
透明边。画满的图标放上去，会比 Dock 里旁边的每一个图标都大一圈，看着很突兀。

用法：
    python3 scripts/make-icon.py <源图>          # 通常是 .icns 或 .png
    python3 scripts/make-icon.py <源图> --scale 0.9

不给 --scale 时用 824/1024（Apple 的标准网格，≈80%）。
输出固定写到 build/icon.icns（打包用）和 build/icon.png（开发态 Dock 用）。

依赖：Pillow（pip3 install Pillow）+ macOS 自带的 iconutil。
"""

import argparse
import subprocess
import sys
import tempfile
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    sys.exit(
        "缺少 Pillow。装一下：pip3 install Pillow\n"
        "如果装过了还是报这个，多半是用 python3 -I 跑的 —— -I 会屏蔽用户级\n"
        "site-packages（Pillow 通常正好装在那儿），去掉 -I 即可。"
    )

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"

# Apple 图标网格：画布 1024，内容 824，四周各 100 透明边。824/1024 ≈ 0.805。
GRID_CONTENT = 824
GRID_CANVAS = 1024

# iconutil 只认这几个文件名，多一个少一个都会报 InvalidIconset
ICONSET_SIZES = [16, 32, 128, 256, 512]


def load_square(src: Path) -> Image.Image:
    """读图并保证是正方形。icns 是多帧的，挑其中最大的一帧。"""
    img = Image.open(src)
    img.load()

    # Pillow 打开 icns 时给的是最大那帧，但这算实现细节 —— 自己数一遍更稳。
    # 必须逐帧 seek 才能真正拿到该帧的尺寸，用 seek 之前的 img.size 是错的。
    if getattr(img, "n_frames", 1) > 1:
        best, best_area = 0, 0
        for i in range(img.n_frames):
            img.seek(i)
            if img.width * img.height > best_area:
                best, best_area = i, img.width * img.height
        img.seek(best)

    img = img.convert("RGBA")
    if img.width != img.height:
        side = max(img.size)
        canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        canvas.paste(img, ((side - img.width) // 2, (side - img.height) // 2))
        img = canvas
    return img


def compose(img: Image.Image, scale: float) -> Image.Image:
    """按比例缩小并居中贴到透明画布上。"""
    content = round(GRID_CANVAS * scale)
    small = img.resize((content, content), Image.LANCZOS)

    canvas = Image.new("RGBA", (GRID_CANVAS, GRID_CANVAS), (0, 0, 0, 0))
    offset = (GRID_CANVAS - content) // 2
    canvas.paste(small, (offset, offset), small)
    return canvas


def edge_alpha(img: Image.Image) -> tuple[int, int, int]:
    """看四条边上还剩多少不透明像素。用来证明『画满』这件事真的被解决了。"""
    a = img.getchannel("A")
    w, h = img.size
    top = max(a.crop((0, 0, w, 1)).getdata())
    bottom = max(a.crop((0, h - 1, w, h)).getdata())
    left = max(a.crop((0, 0, 1, h)).getdata())
    return top, bottom, left


def build_icns(padded: Image.Image, out: Path) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "icon.iconset"
        iconset.mkdir()
        for size in ICONSET_SIZES:
            padded.resize((size, size), Image.LANCZOS).save(iconset / f"icon_{size}x{size}.png")
            padded.resize((size * 2, size * 2), Image.LANCZOS).save(
                iconset / f"icon_{size}x{size}@2x.png"
            )
        subprocess.run(
            ["iconutil", "--convert", "icns", "--output", str(out), str(iconset)],
            check=True,
        )


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("source", type=Path, help="图标源图（.icns / .png）")
    ap.add_argument(
        "--scale",
        type=float,
        default=GRID_CONTENT / GRID_CANVAS,
        help=f"图形占画布的比例，默认 {GRID_CONTENT / GRID_CANVAS:.4f}（Apple 标准网格）",
    )
    ap.add_argument("--out", type=Path, default=BUILD, help="输出目录，默认 build/")
    args = ap.parse_args()

    if not args.source.exists():
        sys.exit(f"找不到源图：{args.source}")
    if not 0.1 <= args.scale <= 1.0:
        sys.exit("--scale 得在 0.1~1.0 之间")

    raw = load_square(args.source)
    print(f"源图 {args.source.name}  {raw.width}×{raw.height}  边缘不透明度 {edge_alpha(raw)}")

    padded = compose(raw, args.scale)
    args.out.mkdir(parents=True, exist_ok=True)

    icns = args.out / "icon.icns"
    build_icns(padded, icns)
    padded.save(args.out / "icon.png")

    t, b, l = edge_alpha(padded)
    print(f"输出 {icns}  ({icns.stat().st_size} bytes)")
    print(f"输出 {args.out / 'icon.png'}")
    print(
        f"图形占 {round(GRID_CANVAS * args.scale)}/{GRID_CANVAS}"
        f"（{args.scale * 100:.1f}%），四周留白 {round((GRID_CANVAS - GRID_CANVAS * args.scale) / 2)}px，"
        f"边缘不透明度 上{t} 下{b} 左{l}"
    )


if __name__ == "__main__":
    main()
