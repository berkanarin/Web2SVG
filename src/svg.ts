import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import PptxGenJS from "pptxgenjs";
import type { CaptureResult } from "./types.js";

function objectName(value: string): string {
  return value
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

export async function writeSvgPackage(result: CaptureResult, outDir: string, _embed: boolean): Promise<void> {
  const layersDir = path.join(outDir, "layers");
  await writeAfterEffectsScript(result, outDir, layersDir);
  await writePowerPoint(result, outDir, layersDir);
  await rm(layersDir, { force: true, recursive: true });
}

async function pngAsBase64(filePath: string): Promise<string> {
  const buffer = await readFile(filePath);
  return buffer.toString("base64");
}

async function writeAfterEffectsScript(result: CaptureResult, outDir: string, layersDir: string): Promise<void> {
  const bg = result.cleanBackground ?? result.background;
  const assets = [
    {
      name: "web2svg_background",
      fileName: bg.fileName,
      x: 0,
      y: 0,
      width: bg.width,
      height: bg.height,
      base64: await pngAsBase64(path.join(layersDir, bg.fileName))
    },
    ...(await Promise.all(
      result.layers.map(async (layer) => {
        const name = objectName(`web2svg_layer_${String(layer.domIndex).padStart(3, "0")}_${layer.label}`);
        return {
          name,
          fileName: layer.fileName,
          x: layer.x * result.viewport.scale,
          y: layer.y * result.viewport.scale,
          width: layer.imageWidth,
          height: layer.imageHeight,
          base64: await pngAsBase64(path.join(layersDir, layer.fileName))
        };
      })
    ))
  ];

  const script = `#target aftereffects
(function () {
  var capture = ${JSON.stringify(
    {
      title: result.title || "Web2SVG Capture",
      url: result.url,
      capturedAt: result.capturedAt,
      width: result.viewport.svgWidth,
      height: result.viewport.svgHeight,
      assets
    },
    null,
    2
  )};

  function decodeBase64(input) {
    var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
    var output = "";
    var index = 0;
    while (index < input.length) {
      var enc1 = chars.indexOf(input.charAt(index++));
      var enc2 = chars.indexOf(input.charAt(index++));
      var enc3 = chars.indexOf(input.charAt(index++));
      var enc4 = chars.indexOf(input.charAt(index++));
      var chr1 = (enc1 << 2) | (enc2 >> 4);
      var chr2 = ((enc2 & 15) << 4) | (enc3 >> 2);
      var chr3 = ((enc3 & 3) << 6) | enc4;
      output += String.fromCharCode(chr1);
      if (enc3 !== 64) output += String.fromCharCode(chr2);
      if (enc4 !== 64) output += String.fromCharCode(chr3);
    }
    return output;
  }

  function safeName(value) {
    return String(value).replace(/[^a-z0-9._-]+/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  }

  function writePng(folder, asset) {
    var file = new File(folder.fsName + "/" + safeName(asset.name) + ".png");
    file.encoding = "BINARY";
    if (!file.open("w")) throw new Error("Cannot write " + file.fsName);
    file.write(decodeBase64(asset.base64));
    file.close();
    return file;
  }

  app.beginUndoGroup("Import Web2SVG");
  try {
    if (!app.project) app.newProject();

    var tempFolder = new Folder(Folder.temp.fsName + "/web2svg_" + new Date().getTime());
    if (!tempFolder.exists) tempFolder.create();

    var compName = "Web2SVG - " + capture.title;
    var comp = app.project.items.addComp(compName, capture.width, capture.height, 1, 10, 30);
    comp.comment = "Captured from " + capture.url + " at " + capture.capturedAt;

    for (var i = 0; i < capture.assets.length; i += 1) {
      var asset = capture.assets[i];
      var file = writePng(tempFolder, asset);
      var footage = app.project.importFile(new ImportOptions(file));
      footage.name = asset.name;

      var layer = comp.layers.add(footage);
      layer.name = asset.name;
      layer.property("Position").setValue([asset.x + asset.width / 2, asset.y + asset.height / 2]);
      layer.property("Scale").setValue([100, 100]);
    }

    comp.openInViewer();
  } finally {
    app.endUndoGroup();
  }
})();
`;

  await writeFile(path.join(outDir, "web2svg_AE.jsx"), script, "utf8");
}

async function writePowerPoint(result: CaptureResult, outDir: string, layersDir: string): Promise<void> {
  const Pptx = PptxGenJS as unknown as typeof import("pptxgenjs").default;
  const pptx = new Pptx();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "Web2SVG";
  pptx.subject = result.url;
  pptx.title = result.title || "Web2SVG Capture";
  pptx.company = "Web2SVG";
  pptx.theme = {
    headFontFace: "Arial",
    bodyFontFace: "Arial"
  };

  const slideWidth = 13.333333;
  const slideHeight = 7.5;
  pptx.defineLayout({ name: "WEB2SVG_16_9", width: slideWidth, height: slideHeight });
  pptx.layout = "WEB2SVG_16_9";

  const slide = pptx.addSlide();
  slide.background = { color: "FFFFFF" };

  const scaleX = slideWidth / result.viewport.svgWidth;
  const scaleY = slideHeight / result.viewport.svgHeight;
  const bg = result.cleanBackground ?? result.background;
  slide.addImage({
    path: path.join(layersDir, bg.fileName),
    x: 0,
    y: 0,
    w: bg.width * scaleX,
    h: bg.height * scaleY,
    objectName: "web2svg_background",
    altText: "web2svg_background"
  });

  for (const layer of result.layers) {
    const name = objectName(`web2svg_layer_${String(layer.domIndex).padStart(3, "0")}_${layer.label}`);
    slide.addImage({
      path: path.join(layersDir, layer.fileName),
      x: layer.x * result.viewport.scale * scaleX,
      y: layer.y * result.viewport.scale * scaleY,
      w: layer.width * result.viewport.scale * scaleX,
      h: layer.height * result.viewport.scale * scaleY,
      objectName: name,
      altText: name
    });
  }

  await pptx.writeFile({ fileName: path.join(outDir, "web2svg_PPTX.pptx") });
}
