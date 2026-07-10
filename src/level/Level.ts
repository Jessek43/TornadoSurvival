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
    // → sheltered building) reads as one continuous surface.
    this.addPatch(scene, terrain, 0, 10, 58, 20, 0x1f2120, 0.02, "asphalt");

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
   * One flat ground-paint rectangle, floated slightly to avoid z-fighting.
   * With a `surface`, it takes the tiled procedural asphalt/concrete texture
   * (GroundTextures); without, it falls back to the old flat color (used for
   * any untextured accent paint).
   */
  private addPatch(
    scene: THREE.Scene,
    terrain: Terrain,
    x: number,
    z: number,
    w: number,
    d: number,
    color: number,
    y: number,
    surface?: GroundSurface,
  ): void {
    const material = surface
      ? makeGroundMaterial(surface, w, d)
      : new THREE.MeshStandardMaterial({ color, roughness: 1 });
    const patch = new THREE.Mesh(new THREE.PlaneGeometry(w, d), material);
    patch.rotation.x = -Math.PI / 2;
    // The paint stays a flat plane (streets/sidewalks keep their UV path); it
    // only MOVES in y — floated its original hair above the substrate at heightAt.
    // (These lots/streets sit on pads or flat field; a single y is correct at
    // amplitude 0 and stays close enough over the gentle field in run two.)
    patch.position.set(x, terrain.heightAt(x, z) + y, z);
    patch.receiveShadow = true;
    scene.add(patch);
  }
}
