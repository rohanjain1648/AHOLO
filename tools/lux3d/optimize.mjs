// Shrinks a Lux3D GLB for the game: weld + simplify to a triangle budget,
// resample animation keys, resize textures to WebP, meshopt-compress.
// The runtime loader registers MeshoptDecoder, so compressed files load.
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, meshopt, prune, resample, simplify, textureCompress, weld } from "@gltf-transform/functions";
import { MeshoptEncoder, MeshoptSimplifier } from "meshoptimizer";
import sharp from "sharp";
import { clipRenames } from "./lib.mjs";

function countTris(doc) {
  let tris = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      const pos = prim.getAttribute("POSITION");
      tris += Math.floor((idx ? idx.getCount() : pos ? pos.getCount() : 0) / 3);
    }
  }
  return tris;
}

export async function optimizeGlb(inPath, outPath, { tris: targetTris, tex, anims }) {
  await MeshoptSimplifier.ready;
  await MeshoptEncoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.encoder": MeshoptEncoder });
  const doc = await io.read(inPath);

  const animations = doc.getRoot().listAnimations();
  const renames = clipRenames(animations.map((a) => a.getName()), anims);
  if (renames) animations.forEach((a, i) => a.setName(renames[i]));

  const trisBefore = countTris(doc);
  const ratio = Math.min(1, targetTris / Math.max(1, trisBefore));

  await doc.transform(
    dedup(),
    weld(),
    ...(ratio < 1 ? [simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.02 })] : []),
    resample(),
    prune(),
    textureCompress({ encoder: sharp, targetFormat: "webp", resize: [tex, tex] }),
    meshopt({ encoder: MeshoptEncoder, level: "medium" }),
  );

  await io.write(outPath, doc);
  return {
    trisBefore,
    trisAfter: countTris(doc),
    clips: doc.getRoot().listAnimations().map((a) => a.getName()),
  };
}
