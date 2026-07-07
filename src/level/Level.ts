import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { GameConfig } from "../config/GameConfig";
import type { Physics } from "../core/Physics";
import { STREET_PATCHES } from "./Neighborhood";
import { makeGroundMaterial, type GroundSurface } from "./GroundTextures";

/**
 * The level's static base: ground plane, ground collider, and the flat
 * "ground paint" — parking lot, streets, sidewalks. All the paint is cheap
 * planes floating a hair above the ground (no geometry, no colliders); the
 * actual structures are stamped by StructureSystem from Hospital.ts +
 * Neighborhood.ts section specs.
 */
export class Level {
  constructor(scene: THREE.Scene, physics: Physics) {
    const size = GameConfig.world.groundSize;

    // Visual ground — one big dark plane; detail comes from lighting/fog.
    // Neutral dark earth (de-greened for the storm palette: green lives in
    // the sky accent and the trees now, not smeared over the ground).
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshStandardMaterial({ color: 0x343330, roughness: 0.95 }),
    );
    ground.rotation.x = -Math.PI / 2; // planes are XY by default; lay it flat
    ground.receiveShadow = true;
    scene.add(ground);

    // Parking-lot asphalt patch in front of the hospital entrance — the same
    // worn-asphalt texture as the streets, so the transition zone (exposed lot
    // → sheltered building) reads as one continuous surface.
    this.addPatch(scene, 0, 10, 58, 20, 0x1f2120, 0.02, "asphalt");

    // Streets + sidewalks (layout owned by Neighborhood.ts so the houses and
    // trees line up with the paint).
    for (const p of STREET_PATCHES) {
      this.addPatch(scene, p.x, p.z, p.w, p.d, p.color, p.y, p.surface);
    }

    // Physical ground — a thick static slab whose top face is y = 0.
    const body = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0),
    );
    physics.world.createCollider(RAPIER.ColliderDesc.cuboid(size / 2, 0.5, size / 2), body);
  }

  /**
   * One flat ground-paint rectangle, floated slightly to avoid z-fighting.
   * With a `surface`, it takes the tiled procedural asphalt/concrete texture
   * (GroundTextures); without, it falls back to the old flat color (used for
   * any untextured accent paint).
   */
  private addPatch(
    scene: THREE.Scene,
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
    patch.position.set(x, y, z);
    patch.receiveShadow = true;
    scene.add(patch);
  }
}
