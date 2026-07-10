import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { GameConfig } from "../config/GameConfig";
import type { Physics } from "../core/Physics";
import { STREET_PATCHES } from "./Neighborhood";
import { heightfieldBuffer, type Terrain } from "./Terrain";
import { makeGroundMaterial, type GroundSurface } from "./GroundTextures";

/**
 * The level's static base: the ground SUBSTRATE (a subdivided height mesh + a
 * Rapier heightfield collider, both sampling Terrain.heightAt) and the flat
 * "ground paint" — parking lot, streets, sidewalks. The mesh + collider consume
 * Terrain's sample grid from OUTSIDE the pure module (Terrain never sees THREE
 * or Rapier). With terrainAmplitude 0 the grid is flat at padY, so this reads
 * byte-identical to the old single-quad plane + cuboid collider top at y = 0.
 *
 * The paint stays cheap UV planes floating a hair above the substrate (no
 * geometry, no colliders), each lifted to heightAt at its centre; the actual
 * structures are stamped by StructureSystem from Hospital.ts + Neighborhood.ts.
 */
export class Level {
  constructor(scene: THREE.Scene, physics: Physics, terrain: Terrain) {
    const size = GameConfig.world.groundSize;

    // Visual ground — a subdivided plane whose vertices are displaced to
    // Terrain.heightAt. Neutral dark earth (de-greened for the storm palette).
    // PlaneGeometry lies in XY; rotation.x = -PI/2 sends local +y → world −z and
    // local +z (the displaced component) → world +y, so each vertex height goes
    // in the local z attribute at world (x, z) = (localX, −localY).
    const geo = new THREE.PlaneGeometry(size, size, terrain.cols, terrain.rows);
    geo.rotateX(-Math.PI / 2); // bake the lay-flat so vertex coords are world-space
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, terrain.heightAt(pos.getX(i), pos.getZ(i)));
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    const ground = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ color: 0x343330, roughness: 0.95 }),
    );
    ground.receiveShadow = true;
    scene.add(ground);

    // Parking-lot asphalt patch in front of the hospital entrance — the same
    // worn-asphalt texture as the streets, so the transition zone (exposed lot
    // → sheltered building) reads as one continuous surface. Tier 0.015 (was
    // 0.02): it overlaps the 0.03 south sidewalk, and at fieldMaxSlope a 0.01 m
    // +y gap is only 0.0099 m of NORMAL separation — a hair under the 0.01 m
    // z-fight floor. Dropping the LOT (not raising the sidewalk, which would lift
    // a visible kerb lip) widens the pair to 0.015 while keeping the lot lowest.
    this.addPatch(scene, terrain, 0, 10, 58, 20, 0x1f2120, 0.015, "asphalt");

    // Streets + sidewalks (layout owned by Neighborhood.ts so the houses and
    // trees line up with the paint).
    for (const p of STREET_PATCHES) {
      this.addPatch(scene, terrain, p.x, p.z, p.w, p.d, p.color, p.y, p.surface);
    }

    // Physical ground — a Rapier heightfield sampling the SAME grid as the mesh.
    // Rapier reads `heights` column-major and maps rows→z / cols→x, the transpose
    // of Terrain's row-major samples[iz·(cols+1)+ix] (ix→x, iz→z): a collider built
    // from samples directly lands every off-diagonal height at world (z, x) — a
    // clean x↔z swap (invisible on the flat amplitude-0 grid, a diagonal-mirrored
    // collider once relief turns on; proven by verify:axes). `heightfieldBuffer`
    // transposes it so the surface equals heightAt(x, z). scale.y = 1 (heights
    // already in metres); at amplitude 0 the surface sits at y = 0, as before.
    const heights = heightfieldBuffer(terrain.samples, terrain.cols + 1);
    const body = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    physics.world.createCollider(
      RAPIER.ColliderDesc.heightfield(terrain.rows, terrain.cols, heights, {
        x: size,
        y: 1,
        z: size,
      }),
      body,
    );
  }

  /**
   * One ground-paint rectangle, DRAPED onto the substrate. The quad is NOT a pad
   * and is NOT snapped to the terrain grid — it keeps its exact (w, d) and is
   * subdivided at a fixed `pavedSegment` step (segments = ceil(size / step)),
   * then every vertex is lifted to `heightAt + tier`. Because `heightAt`
   * interpolates the terrain's own triangles, a vertex sitting anywhere lands
   * exactly on the ground and the paint runs parallel to it a constant `tier`
   * above; the only residual is the chord error inside a sub-quad, held small by
   * the ≤ cellSize/3 step (measured by verify:terrain). Same idiom as the ground
   * mesh above (PlaneGeometry → bake the lay-flat rotation → displace verts). The
   * UV path is untouched: PlaneGeometry keeps 0..1 UVs across the full plane
   * regardless of segment count, so makeGroundMaterial's per-size repeat is
   * unchanged. With a `surface` it takes the tiled asphalt/concrete texture;
   * without, the old flat color (untextured accent paint).
   */
  private addPatch(
    scene: THREE.Scene,
    terrain: Terrain,
    x: number,
    z: number,
    w: number,
    d: number,
    color: number,
    tier: number,
    surface?: GroundSurface,
  ): void {
    const material = surface
      ? makeGroundMaterial(surface, w, d)
      : new THREE.MeshStandardMaterial({ color, roughness: 1 });
    const step = GameConfig.terrain.pavedSegment;
    const segX = Math.ceil(w / step);
    const segZ = Math.ceil(d / step);
    const geo = new THREE.PlaneGeometry(w, d, segX, segZ);
    geo.rotateX(-Math.PI / 2); // bake the lay-flat so vertex coords are world-space (like the ground)
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      // Vertex world (x, z) = patch centre + its baked local offset; drape to the
      // ground the terrain physically has, plus this surface's paint tier.
      pos.setY(i, terrain.heightAt(x + pos.getX(i), z + pos.getZ(i)) + tier);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals(); // smooth-shade the draped plane (the ground mesh is)
    const patch = new THREE.Mesh(geo, material);
    patch.position.set(x, 0, z); // y is baked into the vertices; only offset in XZ
    patch.receiveShadow = true;
    scene.add(patch);
  }
}
