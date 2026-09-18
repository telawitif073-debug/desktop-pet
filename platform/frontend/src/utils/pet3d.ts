import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import type { PetDesign } from './petCanvas';

/** 3D 模型比例参数（与后端 ai.service 的 PetModel3D 对应） */
export interface PetModel3D {
  headSize: number;
  bodyChub: number;
  earLength: number;
  tailLength: number;
  eyeSize: number;
  idleBounce: number;
}

const IDLE_DURATION = 2; // idle 动画时长 s（与循环采样对齐）

function mat(color: string): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness: 0.65, metalness: 0 });
}

/**
 * 程序化搭建 3D 宠物：球体身体/头部 + 圆锥/胶囊耳朵 + 尾巴 + 表情件，
 * 比例由 AI 参数控制，并生成 idle 循环动画（弹跳 + 呼吸 + 头部轻摆 + 尾巴摆动）。
 */
export function buildPet3D(d: PetDesign, m: PetModel3D): { root: THREE.Group; animations: THREE.AnimationClip[] } {
  const root = new THREE.Group();
  root.name = 'pet';

  // ---- 身体 + 肚皮 + 前爪 ----
  const body = new THREE.Group();
  body.name = 'body';
  const bodyMesh = new THREE.Mesh(new THREE.SphereGeometry(0.55 * m.bodyChub, 32, 24), mat(d.bodyColor));
  bodyMesh.scale.set(1, 0.92, 0.95);
  bodyMesh.position.y = 0.55;
  body.add(bodyMesh);
  const belly = new THREE.Mesh(new THREE.SphereGeometry(0.36 * m.bodyChub, 24, 16), mat(d.bellyColor));
  belly.scale.set(1, 0.9, 0.55);
  belly.position.set(0, 0.48, 0.32 * m.bodyChub);
  body.add(belly);
  for (const x of [-0.22, 0.22]) {
    const paw = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 12), mat(d.bodyColor));
    paw.scale.set(1, 0.7, 1.1);
    paw.position.set(x, 0.12, 0.38 * m.bodyChub);
    body.add(paw);
  }
  // 身体花纹
  if (d.pattern === 'spots') {
    const spots: [number, number, number][] = [[-0.3, 0.72, 0.3], [0.32, 0.6, 0.38], [-0.12, 0.4, 0.46], [0.2, 0.85, 0.22]];
    for (const [x, y, z] of spots) {
      const spot = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 8), mat(d.patternColor));
      spot.scale.set(1, 1, 0.4);
      spot.position.set(x * m.bodyChub, y, z * m.bodyChub);
      body.add(spot);
    }
  } else if (d.pattern === 'stripes') {
    for (const [y, z] of [[0.78, 0.28], [0.6, 0.42], [0.42, 0.44]] as const) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.5 * m.bodyChub, 0.045, 8, 32, Math.PI), mat(d.patternColor));
      ring.position.set(0, y, z * 0.4);
      ring.rotation.set(Math.PI / 2, 0, 0);
      body.add(ring);
    }
  }
  root.add(body);

  // ---- 头部（含耳朵/眼睛/鼻嘴/头顶花纹，倾斜时整体联动）----
  const head = new THREE.Group();
  head.name = 'head';
  head.position.set(0, 1.18, 0.04);
  const headR = 0.42 * m.headSize;
  const headMesh = new THREE.Mesh(new THREE.SphereGeometry(headR, 32, 24), mat(d.bodyColor));
  head.add(headMesh);
  // 耳朵
  const earY = headR * 0.85;
  if (d.earShape === 'pointy') {
    for (const x of [-headR * 0.55, headR * 0.55]) {
      const ear = new THREE.Mesh(new THREE.ConeGeometry(0.14 * m.headSize, 0.4 * m.earLength, 16), mat(d.earColor));
      ear.position.set(x, earY + 0.12 * m.earLength, 0);
      ear.rotation.z = x < 0 ? 0.25 : -0.25;
      head.add(ear);
    }
  } else if (d.earShape === 'round') {
    for (const x of [-headR * 0.75, headR * 0.75]) {
      const ear = new THREE.Mesh(new THREE.SphereGeometry(0.15 * m.headSize, 16, 12), mat(d.earColor));
      ear.position.set(x, earY, 0);
      head.add(ear);
    }
  } else {
    for (const x of [-headR * 0.5, headR * 0.5]) {
      const ear = new THREE.Mesh(new THREE.CapsuleGeometry(0.08 * m.headSize, 0.34 * m.earLength, 4, 12), mat(d.earColor));
      ear.position.set(x, earY + 0.18 * m.earLength, 0);
      ear.rotation.z = x < 0 ? 0.15 : -0.15;
      head.add(ear);
    }
  }
  // 眼睛
  for (const x of [-headR * 0.42, headR * 0.42]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.062 * m.eyeSize, 12, 8), mat(d.eyeColor));
    eye.position.set(x, headR * 0.12, headR * 0.86);
    head.add(eye);
  }
  // 鼻子
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), mat('#e8836f'));
  nose.position.set(0, -headR * 0.05, headR * 0.95);
  head.add(nose);
  // 头顶花纹
  if (d.pattern === 'spots') {
    for (const x of [-headR * 0.35, headR * 0.3]) {
      const spot = new THREE.Mesh(new THREE.SphereGeometry(0.055, 10, 8), mat(d.patternColor));
      spot.scale.set(1, 0.5, 1);
      spot.position.set(x, headR * 0.72, headR * 0.35);
      head.add(spot);
    }
  } else if (d.pattern === 'stripes') {
    for (const x of [-headR * 0.3, 0, headR * 0.3]) {
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.16, 0.02), mat(d.patternColor));
      stripe.position.set(x, headR * 0.78, headR * 0.42);
      stripe.rotation.z = x < 0 ? 0.3 : x > 0 ? -0.3 : 0;
      head.add(stripe);
    }
  }
  root.add(head);

  // ---- 尾巴 ----
  let tail: THREE.Group | null = null;
  if (d.hasTail) {
    tail = new THREE.Group();
    tail.name = 'tail';
    tail.position.set(0, 0.72, -0.42 * m.bodyChub);
    if (d.tailStyle === 'curl') {
      const curl = new THREE.Mesh(new THREE.TorusGeometry(0.16 * m.tailLength, 0.062, 10, 28, Math.PI * 1.6), mat(d.bodyColor));
      curl.rotation.set(0, Math.PI / 2, 0.4);
      tail.add(curl);
    } else if (d.tailStyle === 'straight') {
      const rod = new THREE.Mesh(new THREE.CapsuleGeometry(0.062, 0.46 * m.tailLength, 4, 12), mat(d.bodyColor));
      rod.rotation.x = -0.9;
      rod.position.set(0, 0.2 * m.tailLength, -0.16 * m.tailLength);
      tail.add(rod);
    } else {
      const fluff = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.5 * m.tailLength, 16), mat(d.bodyColor));
      fluff.rotation.x = -2.4;
      fluff.position.set(0, 0.18 * m.tailLength, -0.2 * m.tailLength);
      tail.add(fluff);
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 8), mat(d.bellyColor));
      tip.position.set(0, 0.42 * m.tailLength, -0.34 * m.tailLength);
      tail.add(tip);
    }
    root.add(tail);
  }

  // ---- idle 动画（弹跳 + 呼吸 + 头部轻摆 + 尾巴摆动），客户端 AnimationMixer 循环播放 ----
  const steps = 9;
  const times = Array.from({ length: steps }, (_, i) => (i * IDLE_DURATION) / (steps - 1));
  const bounce: number[] = [];
  const breathKeys: number[] = [];
  const headKeys: number[] = [];
  const tailKeys: number[] = [];
  const q = new THREE.Quaternion();
  const euler = new THREE.Euler();
  for (const t of times) {
    const phase = (2 * Math.PI * t) / IDLE_DURATION;
    bounce.push(0, m.idleBounce * Math.abs(Math.sin(phase)), 0);
    breathKeys.push(1, 1 + 0.035 * Math.sin(phase), 1);
    euler.set(0, 0, 0.05 * Math.sin(phase / 2));
    q.setFromEuler(euler);
    headKeys.push(q.x, q.y, q.z, q.w);
    euler.set(0, 0, 0.35 * Math.sin(phase));
    q.setFromEuler(euler);
    tailKeys.push(q.x, q.y, q.z, q.w);
  }
  const tracks: THREE.KeyframeTrack[] = [
    new THREE.VectorKeyframeTrack('pet.position', times, bounce),
    new THREE.VectorKeyframeTrack('body.scale', times, breathKeys),
    new THREE.QuaternionKeyframeTrack('head.quaternion', times, headKeys),
  ];
  if (tail) tracks.push(new THREE.QuaternionKeyframeTrack('tail.quaternion', times, tailKeys));
  return { root, animations: [new THREE.AnimationClip('idle', IDLE_DURATION, tracks)] };
}

function buildScene(d: PetDesign, m: PetModel3D): { scene: THREE.Scene; root: THREE.Group; animations: THREE.AnimationClip[] } {
  const { root, animations } = buildPet3D(d, m);
  const scene = new THREE.Scene();
  scene.add(root);
  return { scene, root, animations };
}

/** 导出 GLB（含 idle 动画），供商店上传（model3d 形态） */
export async function exportPetGlb(d: PetDesign, m: PetModel3D): Promise<Blob> {
  const { scene, animations } = buildScene(d, m);
  const exporter = new GLTFExporter();
  const glb = await new Promise<ArrayBuffer>((resolve, reject) => {
    exporter.parse(scene, (result) => resolve(result as ArrayBuffer), (err) => reject(err), { binary: true, animations });
  });
  return new Blob([glb], { type: 'model/gltf-binary' });
}

/** 渲染 3D 宠物静态预览图（商店展示用） */
export async function renderPet3DPreview(d: PetDesign, m: PetModel3D): Promise<Blob> {
  const { scene, root } = buildScene(d, m);
  scene.add(new THREE.AmbientLight(0xffffff, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(2, 3, 4);
  scene.add(key);

  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(300, 300);
  renderer.setClearColor(0x000000, 0);
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 50);
  camera.position.set(0, 1.0, 3.4);
  camera.lookAt(0, 0.72, 0);
  renderer.render(scene, camera);
  const dataUrl = renderer.domElement.toDataURL('image/png');
  renderer.dispose();
  root.clear();

  const res = await fetch(dataUrl);
  return res.blob();
}

/**
 * 由 AI 主体透明 PNG 导出广告牌式 3D 模型（GLB，model3d 形态）：
 * 主体纹理平面（透明材质、双面）+ idle 弹跳/呼吸动画，与参数化模型同风格，
 * 客户端 GLTFLoader + AnimationMixer('idle') 直接可播。预览图直接用主体 PNG。
 */
export async function exportImageGlb(dataUrl: string): Promise<Blob> {
  const texture = await new THREE.TextureLoader().loadAsync(dataUrl);
  texture.colorSpace = THREE.SRGBColorSpace;

  const root = new THREE.Group();
  root.name = 'pet';
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, alphaTest: 0.01, side: THREE.DoubleSide }),
  );
  plane.name = 'body';
  root.add(plane);

  const IDLE_DURATION = 1.2;
  const times = [0, 0.3, 0.6, 0.9, 1.2];
  const bounce: number[] = [];
  const breath: number[] = [];
  for (const t of times) {
    const phase = (2 * Math.PI * t) / IDLE_DURATION;
    bounce.push(0, 0.06 * Math.abs(Math.sin(phase)), 0);
    breath.push(1, 1 + 0.02 * Math.sin(phase), 1);
  }
  const animations = [
    new THREE.AnimationClip('idle', IDLE_DURATION, [
      new THREE.VectorKeyframeTrack('pet.position', times, bounce),
      new THREE.VectorKeyframeTrack('body.scale', times, breath),
    ]),
  ];

  const exporter = new GLTFExporter();
  const glb = await new Promise<ArrayBuffer>((resolve, reject) => {
    exporter.parse(root, (result) => resolve(result as ArrayBuffer), (err) => reject(err), { binary: true, animations });
  });
  return new Blob([glb], { type: 'model/gltf-binary' });
}
