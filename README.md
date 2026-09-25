# SVG / DXF 轉 G-Code｜網頁版 CAM 工具

> **Web-based SVG/DXF to G-Code CAM Tool** — No installation required, runs entirely in your browser.

🌐 **線上版本 / Live Demo**：[https://cieoco.github.io/svg2gcode-project/](https://cieoco.github.io/svg2gcode-project/)

## 與整體工作流的關係

- `cad`
  - 畫 2D 零件，輸出 `svg`
- `arm`
  - 做 3D 組裝與模擬
- `linkage`
  - 做閉環機構拓樸與零件配置
- `svg2gcode-project`
  - 專心處理 CAM 與 G-code，不負責機構求解或 3D 手臂模擬

---

## 中文說明

### 功能特色

- ✅ 拖曳或點選 SVG / DXF 檔案，免安裝、免後端
- ✅ 支援 **圓弧原生輸出**（G2/G3），不再全是微小 G1 線段，CNC 動作更平滑
- ✅ 支援 `GRBL` 和 `Mach3` 兩種後處理器格式
- ✅ 每個路徑可獨立設定刀路模式：銑線外 / 銑線內 / 銑線上 / 鑽孔 / 不加工
- ✅ 3D 刀路動畫預覽（含播放 / 暫停 / 進度條）
- ✅ 加工順序可拖曳或按上下鍵排序
- ✅ 手機觸控操作：輕點刀路、單指移動、雙指縮放
- ✅ 工件原點設定（頂/底面 × 中心/左下角）
- ✅ 工件旋轉角度設定
- ✅ Tab（固定支撐橋）功能（可設定數量、寬度、厚度）

### 快速開始

#### 方法一：直接開啟線上版

前往 [https://cieoco.github.io/svg2gcode-project/](https://cieoco.github.io/svg2gcode-project/)，直接使用。

#### 方法二：本機執行

```bash
# 克隆專案
git clone https://github.com/cieoco/svg2gcode-project.git
cd svg2gcode-project

# 安裝開發伺服器
npm install

# 啟動本機伺服器（瀏覽 http://localhost:8080）
npx http-server -p 8080 -c-1
```

然後在瀏覽器開啟 `http://localhost:8080`，或直接以瀏覽器開啟 `index.html`。

### 開發與驗證

```bash
npm install
npm test
npx http-server -p 8080 -c-1
```

測試使用 jsdom 30.1.1；Node.js 需符合其版本條件：`^22.22.2 || ^24.15.0 || >=26.0.0`。

SVG 有 `viewBox` 時，根元素需提供至少一項實體 `width` 或 `height`，另一項會依比例推算；沒有 `viewBox` 時，幾何座標按 CSS px 換算（96 px = 25.4 mm）。巢狀群組與元素的 SVG transform 會套用到路徑；同一個 `path` 的各子路徑會分別產生刀路，不會以切削線連接。此工具不是完整 SVG renderer，不支援文字排版、`use`/`symbol`、裁切/遮罩及筆畫外擴等功能。無效的加工參數會阻擋 G-code 生成與下載。

非貫穿深度必須大於 0 且小於材料厚度。陣列最多 400 組、展開後最多 2000 條路徑；超限會停止預覽與生成。SVG 的 `display:none` 與 `visibility:hidden` 幾何不會匯入；目前尚未解析外部樣式表或 class 規則。

完整支援範圍與正確性規格見 [docs/sdd-cam-correctness.md](docs/sdd-cam-correctness.md)，本輪加工安全修正見 [docs/sdd-safety-loop.md](docs/sdd-safety-loop.md)。

手機操作：點選上傳區挑選 SVG／DXF；先選刀路模式，再輕點圖形中的線段。單指移動圖形、雙指縮放，按「適合畫面」可還原。加工順序可用上下鍵調整；若要依手動順序輸出，請關閉「最短路徑」。3D 預覽需要瀏覽器支援 WebGL。

### 使用步驟

1. **拖曳或點擊上傳** SVG 或 DXF 檔案
2. 在右側設定 **CAM 加工參數**（刀具直徑、材料厚度、進給率等）
3. 在左側點擊各個路徑，選擇 **刀路模式**（銑線外/內/上/鑽孔）
4. 視需要調整 **加工順序**（上下拖曳）
5. 按 **「生成並下載 G-Code 檔案」** 輸出 `.nc` 檔案

### CAM 參數說明

| 參數 | 說明 | 預設值 |
|------|------|--------|
| 材料厚度 | 工件實際厚度 (mm) | 7 |
| 過切深度 | 額外下切量，確保切斷 (mm) | 0.0 |
| 每層下刀量 | 每層 Z 軸切削深度 (mm) | 1.5 |
| 安全高度 | G0 快速移動時的 Z 高度 (mm) | 10 |
| XY 進給率 | 水平切削進給速度 (mm/min) | 1000 |
| Z 進給率 | Z 軸下刀速度 (mm/min) | 300 |
| 主軸轉速 | 主軸 RPM | 10000 |
| 刀具直徑 | 銑刀直徑，用於刀徑補償 (mm) | 4 |
| 後處理器 | GRBL 或 Mach3 格式 | GRBL |

### 專案結構

```
svg2gcode-project/
├── index.html              # 主頁面 UI
├── css/
│   └── style.css           # 樣式表
├── js/
│   ├── app.js              # 主應用邏輯（載入、互動、下載）
│   ├── svg-parser.js       # SVG 解析器（Strategy B：直接解析 d 屬性）
│   ├── dxf-parser.js       # DXF 解析器（LINE/LWPOLYLINE/POLYLINE/CIRCLE/ARC）
│   ├── viewer3d.js         # Three.js 3D 刀路預覽
│   ├── utils.js            # 工具函式（數字格式化等）
│   └── cam/
│       ├── generator.js    # G-Code 生成器（統籌各零件）
│       ├── operations.js   # G-Code 操作（profile/drill/arc/tab）
│       └── path-optimizer.js # 路徑優化（Douglas-Peucker 簡化）
├── examples/
│   └── test.svg            # 測試用 SVG 範例
├── .github/
│   └── workflows/
│       └── deploy.yml      # GitHub Pages 自動部署
└── package.json
```

### 技術說明

- **純前端**：無後端伺服器，所有運算在瀏覽器中完成
- **SVG 解析**：Strategy B — 直接解析 `d` 屬性原始指令，圓弧（A 指令）保留為原生 G2/G3
- **路徑優化**：Douglas-Peucker 簡化直線段 + 共線合併，大幅減少 G-Code 行數
- **3D 預覽**：Three.js r128，支援 G2/G3 弧線插補顯示

---

## English Documentation

### Features

- ✅ Drag & drop SVG/DXF files — no installation, no backend required
- ✅ **Native arc output** (G2/G3) — smoother CNC motion vs thousands of micro G1 segments
- ✅ Supports both `GRBL` and `Mach3` post-processor formats
- ✅ Per-path toolpath modes: Outside / Inside / On-Path / Drill / None
- ✅ 3D toolpath animation preview (play / pause / scrub)
- ✅ Drag-to-reorder machining sequence
- ✅ Work origin options (top/bottom face × center/bottom-left)
- ✅ Part rotation angle
- ✅ Tabs/bridges support (count, width, thickness)

### Quick Start

#### Option 1: Use the live version

Visit [https://cieoco.github.io/svg2gcode-project/](https://cieoco.github.io/svg2gcode-project/) — no setup needed.

#### Option 2: Run locally

```bash
git clone https://github.com/cieoco/svg2gcode-project.git
cd svg2gcode-project
npm install
npx http-server -p 8080 -c-1
```

Open `http://localhost:8080` in your browser, or simply open `index.html` directly.

### Usage

1. **Drag & drop** (or click to upload) your SVG or DXF file
2. Configure **CAM parameters** on the right panel (tool diameter, material thickness, feed rates, etc.)
3. Click each path in the preview to assign a **toolpath mode** (outside / inside / on-path / drill)
4. Optionally reorder operations by **dragging** in the machining sequence list
5. Click **"Generate & Download G-Code"** to export `.nc` files

### CAM Parameters

| Parameter | Description | Default |
|-----------|-------------|---------|
| Material Thickness | Actual workpiece thickness (mm) | 7 |
| Overcut | Extra Z depth to ensure full cut-through (mm) | 0.0 |
| Step Down | Z depth per cutting pass (mm) | 1.5 |
| Safe Z | Rapid traverse height (mm) | 10 |
| XY Feed Rate | Horizontal cutting speed (mm/min) | 1000 |
| Z Feed Rate | Plunge speed (mm/min) | 300 |
| Spindle Speed | Spindle RPM | 10000 |
| Tool Diameter | End mill diameter for offset compensation (mm) | 4 |
| Post Processor | GRBL or Mach3 output format | GRBL |

### Project Structure

```
svg2gcode-project/
├── index.html              # Main UI page
├── css/
│   └── style.css           # Stylesheet
├── js/
│   ├── app.js              # Main app logic (load, interact, download)
│   ├── svg-parser.js       # SVG parser (Strategy B: direct d-attribute parsing)
│   ├── dxf-parser.js       # DXF parser (LINE/LWPOLYLINE/POLYLINE/CIRCLE/ARC)
│   ├── viewer3d.js         # Three.js 3D toolpath preview
│   ├── utils.js            # Utilities (number formatting, etc.)
│   └── cam/
│       ├── generator.js    # G-Code generator (orchestrates all parts)
│       ├── operations.js   # G-Code operations (profile/drill/arc/tab)
│       └── path-optimizer.js # Path optimizer (Douglas-Peucker simplification)
├── examples/
│   └── test.svg            # Example SVG for testing
├── .github/
│   └── workflows/
│       └── deploy.yml      # GitHub Pages auto-deploy workflow
└── package.json
```

### How It Works

- **Pure frontend**: All processing happens in the browser — no server needed
- **SVG Parsing**: Strategy B — parses raw `d` attribute commands directly; circular arcs (`A` command with `rx≈ry`) are preserved as native G2/G3 arc moves
- **Path Optimization**: Douglas-Peucker simplification on line segments + collinear merge, significantly reducing G-Code line count
- **3D Preview**: Three.js r128 with proper G2/G3 arc interpolation for accurate toolpath visualization

### Browser Compatibility

Modern browsers with ES Module support: Chrome 80+, Firefox 75+, Edge 80+, Safari 14+

---

## License

MIT
