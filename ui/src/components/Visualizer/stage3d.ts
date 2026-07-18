/**
 * stage3d — minimal hand-rolled WebGL renderer for the Visualizer's "Stage" mode.
 * One lit cube per track bar on a floor grid, orbiting perspective camera.
 * No dependencies; ~1 draw call per bar (≤ a few dozen). Returns null when WebGL
 * is unavailable (caller falls back to 2D bars).
 */

export interface StageBarState {
  x: number;
  z: number;
  /** bar height in world units (level-driven) */
  h: number;
  color: [number, number, number];
  /** 0..1 extra self-glow (recent peak) */
  emissive: number;
}

export interface StageFrame {
  bars: StageBarState[];
  timeMs: number;
  bg: [number, number, number];
  grid: [number, number, number];
}

export interface StageRenderer {
  render(frame: StageFrame): void;
  dispose(): void;
}

/* ---- tiny mat4 helpers (column-major, WebGL convention) ---- */

type Mat4 = Float32Array;

function perspective(fovY: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  const nf = 1 / (near - far);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) * nf;
  m[11] = -1;
  m[14] = 2 * far * near * nf;
  return m;
}

function lookAt(eye: number[], target: number[], up: number[]): Mat4 {
  const z0 = eye[0] - target[0];
  const z1 = eye[1] - target[1];
  const z2 = eye[2] - target[2];
  let len = Math.hypot(z0, z1, z2) || 1;
  const zx = z0 / len;
  const zy = z1 / len;
  const zz = z2 / len;
  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  len = Math.hypot(xx, xy, xz) || 1;
  xx /= len;
  xy /= len;
  xz /= len;
  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;
  return new Float32Array([
    xx, yx, zx, 0,
    xy, yy, zy, 0,
    xz, yz, zz, 0,
    -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
    -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
    -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
    1,
  ]);
}

function mul(a: Mat4, b: Mat4): Mat4 {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] =
        a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

/** translate(x,y,z) · scale(sx,sy,sz) as one matrix. */
function trs(x: number, y: number, z: number, sx: number, sy: number, sz: number): Mat4 {
  const m = new Float32Array(16);
  m[0] = sx;
  m[5] = sy;
  m[10] = sz;
  m[12] = x;
  m[13] = y;
  m[14] = z;
  m[15] = 1;
  return m;
}

/* ---- geometry: unit cube (centered XZ, base at y=0) with face normals ---- */

function cubeVerts(): Float32Array {
  // prettier-ignore
  const faces: Array<[number[], number[]]> = [
    [[0, 0, 1], [0, 1]], [[0, 0, -1], [0, -1]], [[1, 0, 0], [1, 0]],
    [[-1, 0, 0], [-1, 0]], [[0, 1, 0], [0, 0]], [[0, -1, 0], [0, 0]],
  ];
  void faces;
  const p = 0.5;
  // 6 faces × 2 triangles, position(3) + normal(3)
  // prettier-ignore
  return new Float32Array([
    // +z
    -p,0,p, 0,0,1,  p,0,p, 0,0,1,  p,1,p, 0,0,1,  -p,0,p, 0,0,1,  p,1,p, 0,0,1,  -p,1,p, 0,0,1,
    // -z
    p,0,-p, 0,0,-1, -p,0,-p, 0,0,-1, -p,1,-p, 0,0,-1, p,0,-p, 0,0,-1, -p,1,-p, 0,0,-1, p,1,-p, 0,0,-1,
    // +x
    p,0,p, 1,0,0,  p,0,-p, 1,0,0,  p,1,-p, 1,0,0,  p,0,p, 1,0,0,  p,1,-p, 1,0,0,  p,1,p, 1,0,0,
    // -x
    -p,0,-p, -1,0,0, -p,0,p, -1,0,0, -p,1,p, -1,0,0, -p,0,-p, -1,0,0, -p,1,p, -1,0,0, -p,1,-p, -1,0,0,
    // top
    -p,1,p, 0,1,0,  p,1,p, 0,1,0,  p,1,-p, 0,1,0,  -p,1,p, 0,1,0,  p,1,-p, 0,1,0,  -p,1,-p, 0,1,0,
    // bottom
    -p,0,-p, 0,-1,0, p,0,-p, 0,-1,0, p,0,p, 0,-1,0, -p,0,-p, 0,-1,0, p,0,p, 0,-1,0, -p,0,p, 0,-1,0,
  ]);
}

const VS = `
attribute vec3 aPos;
attribute vec3 aNrm;
uniform mat4 uVP;
uniform mat4 uModel;
uniform vec3 uColor;
uniform float uEmissive;
varying vec3 vColor;
void main() {
  vec3 n = normalize(mat3(uModel) * aNrm);
  float diff = max(dot(n, normalize(vec3(0.45, 0.85, 0.35))), 0.0);
  vColor = uColor * (0.30 + 0.70 * diff) + uColor * uEmissive * 0.8;
  gl_Position = uVP * uModel * vec4(aPos, 1.0);
}`;

const FS = `
precision mediump float;
varying vec3 vColor;
void main() { gl_FragColor = vec4(vColor, 1.0); }`;

export function createStageRenderer(canvas: HTMLCanvasElement): StageRenderer | null {
  const gl = canvas.getContext("webgl", { antialias: true });
  if (!gl) return null;

  const compile = (type: number, src: string): WebGLShader | null => {
    const sh = gl.createShader(type);
    if (!sh) return null;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.warn("[stage3d] shader:", gl.getShaderInfoLog(sh));
      return null;
    }
    return sh;
  };
  const vs = compile(gl.VERTEX_SHADER, VS);
  const fs = compile(gl.FRAGMENT_SHADER, FS);
  if (!vs || !fs) return null;
  const prog = gl.createProgram();
  if (!prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;

  const aPos = gl.getAttribLocation(prog, "aPos");
  const aNrm = gl.getAttribLocation(prog, "aNrm");
  const uVP = gl.getUniformLocation(prog, "uVP");
  const uModel = gl.getUniformLocation(prog, "uModel");
  const uColor = gl.getUniformLocation(prog, "uColor");
  const uEmissive = gl.getUniformLocation(prog, "uEmissive");

  const cubeBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, cubeBuf);
  gl.bufferData(gl.ARRAY_BUFFER, cubeVerts(), gl.STATIC_DRAW);

  // floor grid lines (y=0 plane, 17×17)
  const gridLines: number[] = [];
  const EXT = 8;
  for (let i = -EXT; i <= EXT; i++) {
    gridLines.push(i, 0, -EXT, 0, 1, 0, i, 0, EXT, 0, 1, 0);
    gridLines.push(-EXT, 0, i, 0, 1, 0, EXT, 0, i, 0, 1, 0);
  }
  const gridBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, gridBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(gridLines), gl.STATIC_DRAW);
  const gridVerts = gridLines.length / 6;

  gl.enable(gl.DEPTH_TEST);

  const bindGeom = (buf: WebGLBuffer | null): void => {
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(aNrm);
    gl.vertexAttribPointer(aNrm, 3, gl.FLOAT, false, 24, 12);
  };

  const identity = trs(0, 0, 0, 1, 1, 1);

  return {
    render(frame: StageFrame): void {
      const w = canvas.width;
      const h = canvas.height;
      if (w <= 0 || h <= 0) return;
      gl.viewport(0, 0, w, h);
      gl.clearColor(frame.bg[0], frame.bg[1], frame.bg[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.useProgram(prog);

      const a = frame.timeMs * 0.00012; // slow orbit
      const R = 9.5;
      const eye = [Math.sin(a) * R, 4.6, Math.cos(a) * R];
      const vp = mul(perspective(0.9, w / Math.max(1, h), 0.1, 100), lookAt(eye, [0, 0.9, 0], [0, 1, 0]));
      gl.uniformMatrix4fv(uVP, false, vp);

      // floor grid
      bindGeom(gridBuf);
      gl.uniformMatrix4fv(uModel, false, identity);
      gl.uniform3fv(uColor, frame.grid);
      gl.uniform1f(uEmissive, 0.4);
      gl.drawArrays(gl.LINES, 0, gridVerts);

      // bars
      bindGeom(cubeBuf);
      for (const b of frame.bars) {
        gl.uniformMatrix4fv(uModel, false, trs(b.x, 0, b.z, 0.9, Math.max(0.05, b.h), 0.9));
        gl.uniform3fv(uColor, b.color);
        gl.uniform1f(uEmissive, b.emissive);
        gl.drawArrays(gl.TRIANGLES, 0, 36);
      }
    },
    dispose(): void {
      gl.deleteBuffer(cubeBuf);
      gl.deleteBuffer(gridBuf);
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
    },
  };
}
