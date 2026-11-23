# ResolveとAfter Effectsの色変換対応表

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
| ACES | ACEScct - CSC | ACES/ACEScct |
| ACES | ACEScg - CSC | ACES/ACEScg |
| ACES | ACES2065-1 - CSC | ACES/ACES2065-1 |
| Rec.709 | Inverse Rec.709 BT.1886 | Rec.1886 Rec.709 - Display / ACES 2.0 - SDR 100 nits (Rec.709) |
| sRGB | Inverse sRGB Piecewise | sRGB - Display / ACES 2.0 - SDR 100 nits (Rec.709) |
| sRGB | Inverse sRGB Gamma 2.2 | sRGB - Display / ACES 2.0 - SDR 100 nits (Rec.709)（Piecewiseで近似） |

Resolveで `Inverse` と表示される項目は、ACES 2.0のSDR表示変換の逆変換です。AEではディスプレイ名と **ACES 2.0 - SDR 100 nits (Rec.709)** の組み合わせを素材の入力に指定します。`Inverse sRGB Gamma 2.2` は `Inverse sRGB Piecewise` と同じ入力に割り当てるため、Resolveとの間で特に暗部の値に差が出ることがあります。D60 simulation、CanonのRec.2020版、旧世代のカメラプロファイルは自動割り当ての対象外です。 [ACES 2.0の出力変換仕様](https://docs.acescentral.com/system-components/output-transforms/parameters/) · [OpenColorIO Studio構成](https://github.com/AcademySoftwareFoundation/OpenColorIO-Config-ACES/releases/tag/v4.0.0)

FujifilmのF-Log、F-Log2、F-Log2 CはResolveに用意されています。AE標準Studio v4.0には同名の入力がなく、F-Log2／F-Log2 CはFujifilm公式CLFとResolve内蔵IDTで色パッチの変換結果に差があったため、自動割り当ての対象外です。 [Fujifilm公式IDT](https://www.fujifilm-x.com/en-us/support/download/technical-data/)

R2AEはクリップ個別のIDTを優先し、プロジェクト設定に従うクリップはResolveの既定のIDTを読み取ります。対応外のIDTは転送時の通知とAEフッテージのコメントで確認できます。

## ODTとDisplay Color Space

macOSでAE未起動の状態から転送すると、新規AEプロジェクトの **Display Color Space** を次のように設定します。既にAEで開いているプロジェクトへ転送する場合は、そのプロジェクトのカラー設定を使います。

| DaVinci ResolveのACES Output Transform | After EffectsのDisplay Color Space |
|---|---|
| Rec.709 BT.1886 | Rec.1886 Rec.709 - Display / ACES 2.0 - SDR 100 nits (Rec.709) |
| sRGB Piecewise | sRGB - Display / ACES 2.0 - SDR 100 nits (Rec.709) |
| sRGB Gamma 2.2 | Gamma 2.2 Rec.709 - Display / ACES 2.0 - SDR 100 nits (Rec.709) |
| DisplayP3 | Display P3 - Display / ACES 2.0 - SDR 100 nits (P3 D65) |
| P3-D65 | P3-D65 - Display / ACES 2.0 - SDR 100 nits (P3 D65) |
| Extended DisplayP3 (1000 nit) | Display P3 HDR - Display / ACES 2.0 - HDR 1000 nits (P3 D65) |
| P3-D65 ST2084（108／500／1000／2000／4000 nit） | ST2084-P3-D65 - Display / ACES 2.0 - HDR（同じ輝度、P3 D65） |
| Rec.2100 ST2084（500／1000／2000／4000 nit） | Rec.2100-PQ - Display / ACES 2.0 - HDR（同じ輝度、Rec.2020） |

`DisplayP3 Gamma 2.2` など対応先がないODTには、既定の `sRGB - Display / ACES 2.0 - SDR 100 nits (Rec.709)` を使用します。引き継ぎはプロジェクトの表示設定に適用されます。
