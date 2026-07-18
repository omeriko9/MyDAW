import { describe, expect, it } from "vitest";
import { dbToGain, gainToDb } from "../common/Fader";
import {
  BACK_SCALE,
  TOKEN_SCALE_FAR,
  TOKEN_SCALE_NEAR,
  type RoomGeom,
  dbToDepth,
  depthScale,
  depthToGain,
  gainToDepth,
  project,
  tokenScale,
  unproject,
} from "./roomMath";

const G: RoomGeom = { width: 720, height: 432, padX: 46, padTop: 42, padBottom: 64 };
const FRONT_Y = G.height - G.padBottom;
const BACK_Y = G.padTop;
const HALF_W = G.width / 2 - G.padX;

describe("depthScale", () => {
  it("is 1 at the front edge and BACK_SCALE at the back wall", () => {
    expect(depthScale(0)).toBeCloseTo(1, 10);
    expect(depthScale(1)).toBeCloseTo(BACK_SCALE, 10);
  });

  it("decreases monotonically with depth", () => {
    let prev = depthScale(0);
    for (let z = 0.1; z <= 1.001; z += 0.1) {
      const s = depthScale(z);
      expect(s).toBeLessThan(prev);
      prev = s;
    }
  });
});

describe("project", () => {
  it("maps the front corners to the full room width", () => {
    expect(project(-1, 0, G)).toMatchObject({ x: G.width / 2 - HALF_W, y: FRONT_Y });
    expect(project(1, 0, G)).toMatchObject({ x: G.width / 2 + HALF_W, y: FRONT_Y });
  });

  it("maps the back corners to the narrowed back wall", () => {
    const bl = project(-1, 1, G);
    expect(bl.x).toBeCloseTo(G.width / 2 - HALF_W * BACK_SCALE, 8);
    expect(bl.y).toBeCloseTo(BACK_Y, 8);
  });

  it("keeps center pan on the center line at any depth", () => {
    for (const z of [0, 0.3, 0.7, 1]) expect(project(0, z, G).x).toBeCloseTo(G.width / 2, 8);
  });

  it("converges harmonically: equal depth steps shrink on screen toward the back", () => {
    const gap = (z0: number, z1: number) => project(0, z0, G).y - project(0, z1, G).y;
    expect(gap(0, 0.25)).toBeGreaterThan(gap(0.25, 0.5));
    expect(gap(0.25, 0.5)).toBeGreaterThan(gap(0.5, 0.75));
    expect(gap(0.5, 0.75)).toBeGreaterThan(gap(0.75, 1));
  });

  it("clamps pan outside [-1, 1]", () => {
    expect(project(-3, 0, G).x).toBe(project(-1, 0, G).x);
  });
});

describe("unproject", () => {
  it("round-trips project() across the floor", () => {
    for (const pan of [-1, -0.6, 0, 0.42, 1]) {
      for (const z of [0, 0.15, 0.5, 0.85, 1]) {
        const p = project(pan, z, G);
        const w = unproject(p.x, p.y, G);
        expect(w.pan).toBeCloseTo(pan, 6);
        expect(w.z).toBeCloseTo(z, 6);
      }
    }
  });

  it("clamps points outside the floor onto it", () => {
    const below = unproject(G.width / 2, G.height + 50, G); // in front of the front edge
    expect(below.z).toBe(0);
    const above = unproject(G.width / 2, -50, G); // behind the back wall
    expect(above.z).toBe(1);
    const left = unproject(-999, FRONT_Y, G);
    expect(left.pan).toBe(-1);
  });
});

describe("depth ↔ level (fader taper)", () => {
  it("front edge is +12 dB, back wall is gain 0 (-inf)", () => {
    expect(gainToDb(depthToGain(0))).toBeCloseTo(12, 8);
    expect(depthToGain(1)).toBe(0);
  });

  it("0 dB (gain 1) sits at the fader-taper depth", () => {
    expect(gainToDepth(1)).toBeCloseTo(1 - 60 / 72, 8);
    expect(depthToGain(gainToDepth(1))).toBeCloseTo(1, 8);
  });

  it("round-trips typical fader gains", () => {
    for (const db of [12, 6, 0, -6.5, -18, -59]) {
      const gain = dbToGain(db);
      expect(depthToGain(gainToDepth(gain))).toBeCloseTo(gain, 8);
    }
  });

  it("clamps: gains above +12 dB pin to the front edge, 0/-inf pins to the wall", () => {
    expect(gainToDepth(dbToGain(20))).toBe(0);
    expect(gainToDepth(0)).toBe(1);
  });

  it("dbToDepth mirrors the fader ticks (0 dB line matches gainToDepth(1))", () => {
    expect(dbToDepth(12)).toBe(0);
    expect(dbToDepth(-60)).toBe(1);
    expect(dbToDepth(0)).toBeCloseTo(gainToDepth(1), 10);
  });
});

describe("tokenScale", () => {
  it("spans FAR..NEAR across the room and shrinks with depth", () => {
    expect(tokenScale(depthScale(0))).toBeCloseTo(TOKEN_SCALE_NEAR, 8);
    expect(tokenScale(depthScale(1))).toBeCloseTo(TOKEN_SCALE_FAR, 8);
    expect(tokenScale(depthScale(0.5))).toBeLessThan(TOKEN_SCALE_NEAR);
    expect(tokenScale(depthScale(0.5))).toBeGreaterThan(TOKEN_SCALE_FAR);
  });
});
