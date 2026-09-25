# SVG 幾何與加工參數正確性 SDD

狀態：已實作並通過自動測試與兩輪獨立審查；真實瀏覽器與下載檔案驗收由主代理記錄。日期：2026-09-25。

## 1. 目標、查證與範圍

本次 LOOP 修正會產生錯誤切削路徑或讓無效加工參數進入輸出的問題；完成条件為規格、實作、回歸測試、獨立審查及必要修正一致。保留純前端、原生 ES modules、現有 GRBL/Mach3 輸出與 parts 資料契約。

實作前程式查證：

- `js/svg-parser.js` 的 `parseDAttribute` 將所有 M 子路徑寫入同一 moves，並覆寫 startX/startY。`parseSVG` 每個元素只建立一個 part。
- transform 僅讀取元素自己的單一 matrix 或 translate；父層 transform 被忽略。具有非零 b/c 的 matrix 會將 arc 改成單一直線，沒有取樣；radius 未乘元素縮放，鏡像未變更方向。
- 根尺寸僅用 width 推導單一比例，缺 width 默認 1 mm；沒有處理 viewBox 原點、height 或 preserveAspectRatio。
- S/T 共用舊控制點，沒有根據前一個實際線段的命令類型決定是否反射。
- `collectSafetyWarnings` 只回傳警告；生成器仍下載。`buildZLevels` 對負數取絕對值，零/NaN 回退成整層深度；`faceStockOps` 對無效 faceStepdown 也整層下刀。純清掃未納入 hasCutting。
- `getMfgData.readNum` 會將已存在輸入框的空白/無效值變成預設值，使後續驗證看不到錯誤。

範圍限於已支援的 path/rect/circle/ellipse/line/polyline/polygon、SVG transform 屬性、SVG 尺寸、現有生成入口及參數。不要重寫刀徑補償、最佳化器、DXF parser、文字引擎、完整 SVG 渲染或 UI。CSS transform、use/symbol、文字排版、裁切/遮罩、筆畫外擴、填色洞拓樸、巢狀 svg viewport 不在本次支援範圍；不宣稱支援完整 SVG。

## 2. 幾何與介面契約

### 2.1 子路徑

`parseSVG(svgText)` 保持回傳 parts 陣列。每個有實際線段的 SVG 子路徑成為獨立 part，依文件及子路徑順序取得唯一 `Part_N`。每個 part 保持 `barStyle:'path'`、`startPoint`、`moves`、`points`、`holes:[]`。

內部 `parseDAttribute` 可改為回傳子路徑陣列；它不是現有公開 API。每個 M/m 開始新子路徑，第一組座標為起點，後續座標組是隱含 L/l。相對 m 以當下 current point 計算，包括前一路徑 Z 後的起點。Z 只封閉當前子路徑並重設 current point；沒有 Z 的開放路徑保持開放。純 M 空路徑略過。不同子路徑絕不可出現切削連接線。

Z 同時完成並送出目前子路徑。其後直接出現 L/l、C/S、Q/T 等非 M 繪圖命令時，從剛恢復的起點開始新的子路徑與 part；不可把新線段接入已封閉 part。末尾 Z 或重複 Z 不產生空 part。新 part 的 G-code 須先退到安全高度再定位與下刀。

不在本輪將複合 path 自動判定成外輪廓與孔；各子路徑沿用現有使用者選刀路流程。

### 2.2 平滑命令狀態

追蹤上一個「實際線段」的命令類型。S 僅在前一段為 C/S 時反射 cubic 第二控制點，否則第一控制點等於 current point。T 僅在前一段為 Q/T 時反射 quadratic 控制點，否則控制點等於 current point。M、Z、L、H、V、A 及不同曲線家族皆使不相容的反射失效。同一命令的多組參數必須逐段更新狀態。

### 2.3 變換

採六元素 affine matrix：`x'=a*x+c*y+e`、`y'=b*x+d*y+f`。支援 matrix、translate、scale、rotate（含旋轉中心），以及 skewX/skewY，或對後兩者明確報不支援；不可忽略不認識或參數不足的 transform。

列向量下，列表 `translate(10 20) scale(2)` 的矩陣為 T*S；(1,2) 結果為 (12,24)。父層與子層為 parent*child。將根 svg 與 g 祖先 transform、元素 transform 累積，再套 viewport 映射與最後 Y 反向。所有點、起點、控制點、圓心必須走同一變換。

最終座標為 mm，Y 向上。無 transform 的 `A ... 0 1 ...` 在 Y 翻轉後 `clockwise=true` 是正確行為；原始碼部分註解相互矛盾，不能據此再翻一次。相對於此既有基準，元素累積矩陣 determinant<0 才額外翻轉 clockwise。

只有正交且兩軸等長、非零的線性變換（similarity）可以直接保留圓形 arc；旋轉、均勻縮放與鏡像都包括在內。radius 乘比例，center/to/start 全部變換，反射正確翻向。不可只憑 b/c 非零就將圓弧變直線。

非均勻縮放或剪切使圓變橢圓，應沿原弧參數取樣，再逐點變換為 line moves；不可只留下終點弦線。既有橢圓與 Bézier 取樣需考慮累積變換尺度。取樣至少維持既有 0.5 mm 最終座標步距目標；測試使用下列中等尺寸案例，允許曲線幾何取樣誤差 0.05 mm。不可為固定段數上限而默默接受嚴重失真；若加入資源上限，超過時明確拒絕。退化/非有限矩陣拒絕匯入，避免加工坍縮形狀。

`points` 必須由最終 moves 建立並正確採樣弧，包含相同起點/終點；預览 bounds 與 CAM 幾何一致。相同圓的 start、to 到 center 距離必須等於 radius。

## 3. 尺寸規則

支援根 width/height 的有限正數及 mm、cm、in、pt、px；無單位按 px，96 px = 25.4 mm。百分比與不支援單位明確拒絕，禁止 parseFloat 截斷後當合法尺寸。viewBox 必須恰好四個有限數字，寬高均大於零。

有 viewBox 時：

1. width/height 皆提供：轉換成實體 viewport 大小。
2. 只提供一項：按 viewBox 比例推導另一項，採明確固定規則。
3. 兩項皆缺：拒絕並提示「SVG 只有 viewBox，請提供 width 或 height 實體尺寸」。不可猜成 1 mm/user unit。
4. 預設 `preserveAspectRatio` 為 `xMidYMid meet`：`s=min(viewportW/vbW,viewportH/vbH)`，置中留白，並扣除 viewBox 的 minX/minY。`none` 使用各軸比例。其他對齊/slice 可完整實作或明確拒絕，不能當預設值處理。

沒有 viewBox 時，幾何無單位座標一律是 CSS px，即 25.4/96 mm/user unit；根 width="100mm" 不會把幾何座標的 1 變成 1 mm。無 viewBox 且無 width/height 也採這項明確 px 規則。已有但無效的根尺寸仍拒絕。原始 geometry 屬性的相對單位或 CSS 計算不在本次擴充。

## 4. 加工驗證與阻擋

### 4.1 共同純函式

新增 `js/cam/validation.js`，匯出 `validateMachiningInputs(parts,mfg)`，回傳 `{errors: string[], warnings: string[]}`，不修改參數、不接 DOM、不生成 G-code。既有非阻擋建議可留在 app 的 `collectSafetyWarnings`，此 API 的 warnings 可以是空陣列。

加工模式 active 為 outside/inside/on-path/drill；generator 既有未設定模式按 on-path 的契約需一致。none 不活動。面清掃啟用且有實際深度是活動加工；請勿只用 parts.length 判定。

清掃深度 0 為 inactive，不生成清掃刀路，也不驗證未使用的 faceStepdown；但 UI 已啟用清掃定位時，仍保留使用者選定的胚料角落與頂面/底面對刀基準。不得因沒有清掃運動而回退到已停用的工件原點選單。`getProgramOriginContext` 分離 `useFaceDatum` 與 `faceMotionActive`，app 使用相同結果決定 XYZ 偏移、原點說明和 viewer 原點。

有活動加工時，必須有限且 `feedXY>0`、`feedZ>0`、`toolD>0`、`safeZ>original stockTopZ`；stockTopZ 省略時為 0，但明確傳入非有限值應報错。安全高度與頂面以同一內部座標系比较；底面對刀後對全部 Z 平移不改變這個不等式。清掃加輪廓時用清掃前頂面檢查安全高度。

有輪廓加工時 stepdown 必須有限且 >0；純清掃使用 faceStepdown，未使用的輪廓 stepdown 不應攔截純清掃。輪廓所需 thickness 必須有限且 >0，overcut 必須有限且 >=0，實際目標 Z 應低於起始頂面。清掃活動時 faceStepdown 必須有限且 >0，實際清掃深度必須有限且 >0，stockBounds 四個座標須有限且 maxX>minX、maxY>minY。使用者明確輸入負/無效清掃深度不能經 Math.max 或 || 默默變成關閉；合法的底面對刀清掃深度由原有厚度規則推導。

保持 spindle=0 手動主軸情境為建議，不新增阻擋。步深超過材料厚度、支撐橋設定、胚料偏小與刀具銑不進輪廓等原有軟警告保持原流程，不在此輪大幅擴充安全政策。

### 4.2 入口與底層

- `getMfgData`：輸入元素存在但空白/無效，核心受驗證數值保留 NaN；只有元素不存在才用相容預設值。預設 UI 本身繼續提供正常值。
- `buildProgram`：參數原值在會隱藏錯誤的 Math.max、||、effective 值覆寫之前必要時先檢查；解析完整有效清掃/原點參數後執行共同驗證，回傳 `{blocked:true,errors:[...]}` 或丟出可讀錯誤。須早於 G-code 生成、Blob、anchor.click 及更新成功預覽。
- 下載按鈕顯示具體欄位錯誤，不可將參數錯誤當成「尚未指定任何刀路」。即時預覽遇錯不得將舊路徑顯示為新參數計算結果；清除或顯示無效狀態即可。
- `buildAllGcodes` 本身也驗證，errors 非空便 throw Error，不回傳任何部分完成的檔案。直接調用 generator 的測試/後續程式不能繞過安全規則。
- `buildZLevels` 對非有限座標與 <=0/非有限 stepdown 丟錯，禁止 abs 負數或回退全深。合法 topZ=cutZ 回空陣列。`faceStockOps` 不可先將壞 faceStepdown 轉成 faceDepth；活動清掃應直接驗證/傳遞正值。

## 5. 明確驗收案例

除特別說明，SVG fixture 根使用 `width="100mm" height="100mm" viewBox="0 0 100 100"`；比較直接 parseSVG 結果，不套 app 原點正規化。線性座標/半徑容差 1e-6 mm，曲線取樣幾何容差 0.05 mm。G-code 採 fmt 輸出精度容差。

| ID | 輸入 / 操作 | 必須結果 |
|---|---|---|
| G01 | `M0 0 L10 0 M20 0 L30 0` | 2 parts；起點 (0,0)/(20,0)，終點 (10,0)/(30,0)，沒有 10→20 或 20→10 的切削線 |
| G02 | `M0 0 L10 0 L10 10 Z m20 0 l10 0` | 第一 part 封閉回 (0,0)；第二 part 從 (20,0) 到 (30,0)，開放 |
| G03 | `m1 2 3 4 5 6 M50 50` | 一個非空 part，依序 (1,-2),(4,-6),(9,-12)，最後純 M 不產生 part |
| G03a | `M0 0 L10 0 L10 10 Z L20 0` | 兩個 parts；第一個封閉三角形，第二個從 (0,0) 到 (20,0)；切第二個前先退刀。Z 後 S/T 也必須成為第二個 part |
| G04 | `M0 0 C0 10 10 10 10 0 L20 0 S30 10 40 0` | S 段等價於 `C20 0 30 10 40 0`，不反射前面 C 舊控制點 |
| G05 | `M0 0 Q10 10 20 0 L30 0 T40 0`；另以 C→T、Q→S、M→S/T、Z→S/T | T 等價於 Q30 0 40 0；其餘跨家族/重設案例不反射 |
| G06 | 連續 C→S、Q→T，S/T 同命令多組參數 | 等價於展開後的顯式 C/Q；每段均正確更新控制點 |
| G07 | 父 g `translate(10 20)`，子 g `scale(2)`，line (1,2)→(3,4) | (12,-24)→(16,-28)；元素同列表 `translate(10 20) scale(2)` 得相同結果 |
| G08 | line (11,10)→(12,10)，`rotate(90 10 10)` | (10,-11)→(10,-12) |
| G09 | `M10 0 A10 10 0 0 1 0 10`，無 transform | center=(0,0), radius=10, to=(0,-10), clockwise=true；points 在第四象限，非另外 270° 弧 |
| G10 | G09 加 `rotate(90) scale(2)`；另測 matrix 等價 | 保持 arc，start=(0,-20), to=(-20,0), radius=20, clockwise=true |
| G11 | G09 加 `scale(-1 1)` | start=(-10,0), to=(0,-10), radius=10, clockwise=false；最終 G3（on-path 無材料反向） |
| G12 | G09 加 `scale(2 1)` | 多段 line；中點弧附近 (14.1421356,-7.0710678) 到 polyline 距離 <=0.05；不可只是 (20,0)→(0,-10) |
| G13 | 非圓橢圓、剪切 matrix；旋轉過的 circle | 非圓輪廓取樣正確；circle 保持完整圓且 points bounds 保留曲率 |
| U01 | width=25.4mm、height=25.4mm、viewBox=0 0 96 96，line 0→96 | 長度 25.4 mm；1in/2.54cm/72pt/96px/無單位96 等價 |
| U02 | width=100mm、height=50mm、viewBox=10 20 100 50，line (10,20)→(110,70) | (0,0)→(100,-50) |
| U03 | width=200mm、height=100mm、viewBox=0 0 100 100 | default meet：(0,0)→(100,100) 映至 (50,0)→(150,-100)；none 映至 (0,0)→(200,-100) |
| U04 | viewBox=0 0 100 50，僅 width=100mm；僅 height=50mm | 都推導 1mm/user unit；兩者皆缺明確拒絕 |
| U05 | 無 viewBox，width=100mm，line (0,0)→(96,0)；無 root 尺寸 | 兩者線長均 25.4 mm |
| U06 | width=100%、width=NaN、非法 viewBox、無效/未知 transform | 明確錯誤；不可回傳看似成功的部分幾何 |
| V01 | 合法輪廓，逐一把 feedXY/feedZ/toolD 改為 0、負數、NaN、Infinity | 共同驗證報錯，buildAllGcodes 拋錯；UI 不下載 |
| V02 | topZ=0 safeZ=0/-1；topZ=5 safeZ=5/4；safeZ=NaN | 全部阻擋；topZ=5 safeZ=6 正常 |
| V03 | 輪廓 stepdown=0/-1/NaN/Infinity；直接 buildZLevels(0,-3,bad) | 拒絕；不可生成全深單刀；(0,-3,1) 得 [-1,-2,-3] |
| V04 | `buildAllGcodes([],mfg)`，合法清掃 | 有 facing.nc；逐一設 bad feedXY/feedZ/toolD/safeZ/faceStepdown 都阻擋；純清掃 stepdown=0 不影響 |
| V05 | 清掃+輪廓、頂面/底面對刀、清掃後 stockTopZ 下降 | 先清掃再從新頂面切，安全高度與原始粗胚頂面比較；Z 整体平移仍保持安全間距 |
| V05a | 清掃定位啟用、bl-bottom、stockT=thickness=7、清掃量0、safeZ=5、overcut=0、有輪廓，舊 originMode=top-bottomleft | 無清掃刀路；仍以胚料左下角/底面定位，輪廓最低 Z0、安全 Z12、viewer 為 bottom-face；不能輸出最低 Z-7 或改用圖形角落 |
| V06 | UI 先成功生成，再清空進給/步深/刀徑或改為0並生成/即時預覽 | 顯示具體錯誤，不觸發下載、不展示舊結果為新計算結果；填回合法值可恢复 |
| R01 | 多子路徑以 on-path 產生程式 | 第二路徑 XY 空移前先 G0 到 safeZ；子路徑間沒有在切深處 G1 連接 |
| R02 | examples/test.svg、既有 DXF、正常圓弧、GRBL/Mach3、純清掃 | 仍可使用；SVG 示例根無單位 width 按 px 保持原有 96dpi；DXF 幾何不改 |

曲線等價測試可比較取樣點序列或與獨立公式評估的折線距離，不可只斷言函式不拋錯。非均勻弧測試要檢查內部曲率，圓弧方向測試要檢查 swept quadrant，不能只檢查終點。

## 6. 實作與驗證 LOOP

1. 依規格先建立會在現行程式失敗的核心回歸；採輕量 Node 測試或瀏覽器 harness，使 `npm test` 可重現。DOMParser 由可用測試 DOM 提供，避免為測試引入前端框架。
2. SVG 實作獨立處理解析/矩陣/尺寸；CAM 實作處理驗證/生成與 UI 入口，避免互改相同檔案。
3. 執行幾何、參數與輸出回歸，完成一次真實瀏覽器操作，至少覆蓋複合 path 匯入、合法生成、非法欄位阻擋與純清掃。
4. 獨立審查特別檢查 M 分離、矩陣順序、圓弧方向、mm 尺寸、驗證前預設值覆蓋、清掃入口繞過及 stale preview。發現問題先修正，再只重跑受影響回歸與必要完整 gate。
5. 所有阻擋問題清除、測試通過才結束。交付回報實際測試命令/結果與尚未支援的 SVG 功能；此規格是加工資料正確性範圍，不代表所有機台或刀具工況的安全認證。

### 本次 LOOP 紀錄

- 第一輪：`npm test` 36/36 通過，獨立審查仍重現兩項阻擋問題：Z 後繪圖命令未建立獨立 part，以及底面零清掃量時悄悄改變對刀基準。兩者交回實作者補修並增加回歸。
- 第二輪：`npm test` 43/43 通過。針對兩項修正的獨立審查未發現剩餘阻擋問題；Z 之後 L/S/T 與末尾 Z 已有明確拓樸及退刀驗收。
- 模型分工：GPT-6 Astra 負責規格與獨立審查；GPT-6 Luna 負責程式、測試及補修。初始 10 項核心回歸皆能重現錯誤，再依規格擴充至目前測試集。
- 真實瀏覽器驗收完成：複合 SVG 匯入為兩條獨立路徑；只有 viewBox 的尺寸不明檔案明確拒絕；合法輪廓與純清掃均實際下載 `.nc`。空白/零進給、零刀徑、零安全高度、零輪廓步深與零清掃步深顯示欄位錯誤並清除舊預覽。
- 瀏覽器下載檔核對：胚料 50×20×7 mm、兩條分離線、一般原點設頂面、清掃定位設左下角底面、量測厚度等於材料厚度，清掃量為零。實際檔案最低 Z0、安全 Z17（安全間距10），兩條路徑分別從 X10/Y10 與 X30/Y10 接近，段間先退刀，且沒有清掃段；對刀基準未退回一般原點。
- 整合重現使用實際 app `buildProgram`、`applyGcodeOffset`，連同正式 validator、origin context、generator 與 G-code header/footer，外部 UI 狀態由 VM harness 提供。底面厚度相等/零清掃量得到 Z0 至 Z12；底面粗胚10、成品7、清掃3得到 Z0 至 Z15；頂面零清掃量得到 Z-7 至 Z5。三者皆保留胚料角落定位，原點說明與 viewer 原點一致。這項驗證覆蓋 app 對 helper 的實際整合，不等同真實瀏覽器驗收。


## 推送前整合遠端（2026-09-25）

整合 origin/master 的 5 筆提交至 57f273b。遠端更新取代本文件前述清掃模型：清掃為獨立工序，使用 faceToolD / faceFeedXY / faceFeedZ，清掃量直接採用 surfaceCleanDepth，不再由材料厚度推算；保留平均分層、精修與主軸方向設定。驗證依實際工序選擇欄位，零深度時保留對刀基準。

新增實際 buildProgram 的整合測試，確認清掃不依賴零件參數、底面偏移、精修與 M4、非法參數阻擋、零深度輪廓加工。整合後 npm test：46/46 通過；修改模組語法檢查通過。原瀏覽器檢查紀錄屬整合前版本。
