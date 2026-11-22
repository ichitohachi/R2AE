# ResolveとAfter EffectsのIDT対応表

ResolveのACES 2.0（ACEScc／ACEScct）から、After Effects 26.5以降の標準 **ACES 2.0 Studio v4.0** プロジェクトに転送する際の対応です。AEの項目は **フッテージを変換 → カラー → Override Media Color Space** にあります。表示変換を選ぶ項目は **Show all** をオンにすると表示されます。

| 系統 | DaVinci ResolveのACES Input Transform | After EffectsのOverride Media Color Space |
|---|---|---|
| Sony | Sony SLog3 SGamut3 - CSC | Input/Sony/S-Log3 S-Gamut3 |
| Sony | Sony SLog3 SGamut3Cine - CSC | Input/Sony/S-Log3 S-Gamut3.Cine |
| Sony | Sony Venice SLog3 SGamut3 - CSC | Input/Sony/S-Log3 Venice S-Gamut3 |
| Sony | Sony Venice SLog3 SGamut3Cine - CSC | Input/Sony/S-Log3 Venice S-Gamut3.Cine |
| ARRI | ARRI LogC3 | Input/ARRI/ARRI LogC3 (EI800) |
| ARRI | ARRI LogC4 - CSC | Input/ARRI/ARRI LogC4 |
| Blackmagic Design | Blackmagic Design Film Gen 5 - CSC | Input/BlackmagicDesign/BMDFilm WideGamut Gen5 |
| Canon | Canon Log 2 Cinema Gamut - CSC | Input/Canon/CanonLog2 CinemaGamut D55 |
| Canon | Canon Log 3 Cinema Gamut - CSC | Input/Canon/CanonLog3 CinemaGamut D55 |
| RED | RED Log3G10 REDWideGamutRGB - CSC | Input/RED/Log3G10 REDWideGamutRGB |
| ACES | ACEScg - CSC | ACES/ACEScg |
| ACES | ACES2065-1 - CSC | ACES/ACES2065-1 |
| Rec.709 | Inverse Rec.709 BT.1886 | Rec.1886 Rec.709 - Display / ACES 2.0 - SDR 100 nits (Rec.709) |
| sRGB | Inverse sRGB Piecewise | sRGB - Display / ACES 2.0 - SDR 100 nits (Rec.709) |

Resolveで `Inverse` と表示される2項目は、ACES 2.0のSDR表示変換の逆変換です。AEではディスプレイ名と **ACES 2.0 - SDR 100 nits (Rec.709)** の組み合わせを素材の入力に指定します。D60 simulation、sRGB Gamma 2.2、CanonのRec.2020版、旧世代のカメラプロファイルは自動割り当ての対象外です。 [ACES 2.0の出力変換仕様](https://docs.acescentral.com/system-components/output-transforms/parameters/) · [OpenColorIO Studio構成](https://github.com/AcademySoftwareFoundation/OpenColorIO-Config-ACES/releases/tag/v4.0.0)

FujifilmのF-Log、F-Log2、F-Log2 CはResolveに用意されています。AE標準Studio v4.0には同名の入力がなく、F-Log2／F-Log2 CはFujifilm公式CLFとResolve内蔵IDTで色パッチの変換結果に差があったため、自動割り当ての対象外です。 [Fujifilm公式IDT](https://www.fujifilm-x.com/en-us/support/download/technical-data/)

R2AEはクリップ個別のIDTを優先し、プロジェクト設定に従うクリップはResolveの既定のIDTを読み取ります。対応外のIDTは転送時の通知とAEフッテージのコメントで確認できます。
