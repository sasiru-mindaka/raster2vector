<div align="center">

# Raster2Vector

### Turn your images into scalable SVG artwork — right in your browser.

[![Runs in browser](https://img.shields.io/badge/runs-in%20your%20browser-16a34a?style=for-the-badge)](#privacy-first)
[![Python](https://img.shields.io/badge/Python-testing%20only-3776AB?style=for-the-badge&logo=python&logoColor=white)](#testing)
[![JavaScript](https://img.shields.io/badge/JavaScript-app%20engine-F7DF1E?style=for-the-badge&logo=javascript&logoColor=111827)](#)

**Upload a picture. Choose how it should be converted. Download an SVG.**

</div>

---

## ✨ What is Raster2Vector?

Raster2Vector is a browser-based image converter. It rebuilds a picture as an SVG file, so you can open the result in vector-editing software and scale vector artwork without the usual pixel blur.

Your image is processed on your own device. Raster2Vector does not need a Python server, an online conversion API, or an account to convert an image.

## 🚀 Features

- 📂 Open PNG, JPG, WEBP, GIF, BMP and AVIF images.
- 🎨 Choose between three conversion modes.
- 🔍 Preview the original image and the SVG result.
- ⚙️ Adjust colours, detail and conversion settings.
- 💾 Download the result as an SVG file.
- 🔒 Process images locally in your browser.

<details>
<summary><strong>🧩 See the three conversion modes</strong></summary>

| Mode | What it does | Best for |
|---|---|---|
| **Pure Vector Photo** | Rebuilds the image using SVG shapes and gradients. It does not put a PNG or JPG inside the SVG. | Artwork you want to zoom into or scale up. Small photo details may look different. |
| **Hybrid Vector** | Combines vector shapes with an image layer to keep more of the photo's detail. The image layer can look blurry when highly zoomed. | Photos where keeping the original appearance is important. |
| **Pixel-Exact** | Recreates the picture using its original pixel information. The SVG can be very large. | Pixel art and images where pixels must stay as they are. |

**Tip:** Pure Vector Photo is the default mode. It is designed for scalable output. For images with transparency, choose Hybrid Vector or Pixel-Exact.

</details>

## ⚡ Get started

### What do I need?

| Tool | Needed to use the app? | Why? |
|---|---:|---|
| 🌐 Modern web browser | **Yes** | Runs the app and converts your images. |
| 🟢 Node.js | Only to run the included local preview server or developer tests | Starts the local web server and runs JavaScript tools. |
| 🐍 Python 3 | **No — testing only** | Used by optional real-image and browser automation tests. It is not used by the app or its conversion features. |

> **Important:** Python is only for the optional test tools. You do not need Python to use Raster2Vector or convert images. When deploying to a static host such as GitHub Pages, visitors only need a modern browser.

### Run it on your computer

The included local server uses Node.js and its built-in modules. It does not need Python packages.

1. Download this repository and unzip it.
2. Install [Node.js](https://nodejs.org/) if it is not already installed.
3. Open a terminal in the `raster2vector` folder.
4. Run:

   ```bash
   npm run serve
   ```

5. Open <http://127.0.0.1:8000> in your browser.

On Linux, you can also run:

```bash
./run-linux.sh
```

Keep the terminal open while using the app. Press <kbd>Ctrl</kbd> + <kbd>C</kbd> to stop the server.

### Convert your first image

1. Open Raster2Vector in your browser.
2. Drop an image into the upload area, or click it to choose a file.
3. Choose a conversion mode. Start with **Pure Vector Photo** for scalable artwork.
4. Change the settings if you want to. The default settings are ready to use.
5. Click **Generate** and wait for the preview.
6. Click **Download SVG** to save your new file.

<blockquote>
  <strong>Image limits:</strong> up to 25 MB and 12 megapixels.
</blockquote>

## 🧪 Testing

Python is **only required for the Python-based tests**. It is not part of the website, image processing engine, or SVG export feature.

### 1. Install developer tools

Install [Node.js](https://nodejs.org/) and then run:

```bash
npm install
```

### 2. Run the main tests (Python not needed)

```bash
npm test
```

### 3. Run real-image tests (Python needed)

Install the Python test packages:

```bash
python3 -m pip install "playwright>=1.48" "Pillow>=10.0" "numpy>=1.26" "scikit-image>=0.23" "CairoSVG>=2.7"
```

Run the image tests:

```bash
npm run test:photo
npm run test:hybrid
```

### 4. Run the optional browser test (Python needed)

Install Playwright's Chromium browser once:

```bash
python3 -m playwright install chromium
```

Then run:

```bash
npm run test:e2e
```

GPU test results depend on your browser, graphics drivers and hardware. The app also supports CPU fallback where available.

## 📁 Project layout

```text
raster2vector/
├── index.html             Main web page
├── assets/
│   ├── css/               Page styles
│   └── js/                App, conversion engine and Web Worker
├── src/                   TypeScript source files
├── tests/                 Automated tests and sample images
├── package.json           Project commands and development tools
├── serve.mjs              Small local web server (Node.js)
└── run-linux.sh           Linux start script
```

## 🔒 Privacy first

- Images are opened and processed in your browser.
- The conversion engine does not upload your picture to a conversion service.
- You choose where to save the exported SVG.

## 🤝 Contributing

Bug reports, ideas and improvements are welcome. Please include clear steps to reproduce a problem and, when possible, a small sample image that you are allowed to share.

## 📄 License

Raster2Vector is licensed under the **MIT License**. The project metadata declares the license as `MIT` in `package.json`.

---

<div align="center">

**Raster2Vector · Image to SVG, made simple.**

</div>
