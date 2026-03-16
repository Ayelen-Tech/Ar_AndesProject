  import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';
  import { MindARThree } from 'https://cdn.jsdelivr.net/npm/mind-ar@1.2.5/dist/mindar-image-three.prod.js';


const holoVertexShader = `
  varying vec2 vUv;
  varying vec3 vNormal;

  void main() {
    vUv = uv;
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const holoFragmentShader = `
  precision mediump float;

  uniform float uTime;
  uniform vec3  uColorA;
  uniform vec3  uColorB;

  varying vec2 vUv;
  varying vec3 vNormal;

  void main() {

    // Líneas de escaneo horizontales
    float scan = sin(vUv.y * 40.0 - uTime * 3.0) * 0.5 + 0.5;
    scan = pow(scan, 6.0);

    // Líneas de escaneo verticales (más suaves)
    float scanV = sin(vUv.x * 20.0 + uTime * 1.5) * 0.5 + 0.5;
    scanV = pow(scanV, 10.0) * 0.4;

    // Borde brillante (marco del holograma)
    float ex = smoothstep(0.0, 0.06, vUv.x) * smoothstep(1.0, 0.94, vUv.x);
    float ey = smoothstep(0.0, 0.06, vUv.y) * smoothstep(1.0, 0.94, vUv.y);
    float edge = ex * ey;
    float glow = 1.0 - edge;

    // Pulso global
    float pulse = sin(uTime * 2.0) * 0.08 + 0.92;

    // Color final mezclando A y B según posición Y
    vec3 color = mix(uColorA, uColorB, vUv.y);
    color += vec3(scan * 0.25 + scanV);
    color += uColorA * glow * 0.6;

    float alpha = (0.35 + scan * 0.25 + glow * 0.4 + scanV * 0.1) * edge * pulse;
    alpha = clamp(alpha, 0.0, 0.95);

    gl_FragColor = vec4(color, alpha);
  }
`;

const waveVertexShader = `
  uniform float uTime;
  uniform float uAmplitude;

  varying vec2  vUv;
  varying float vDisplace;
  varying vec3  vNormal;

  void main() {
    vUv = uv;

    float wave = sin(position.x * 5.0 + uTime * 2.5)
               * cos(position.y * 5.0 + uTime * 2.0)
               * uAmplitude;

    vDisplace = wave;
    vNormal   = normalize(normalMatrix * normal);

    vec3 displaced = position + normal * wave;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
  }
`;

const waveFragmentShader = `
  precision mediump float;

  uniform float uTime;
  uniform vec3  uColorA;
  uniform vec3  uColorB;
  uniform vec3  uColorC;

  varying vec2  vUv;
  varying float vDisplace;
  varying vec3  vNormal;

  void main() {
    float t = clamp(vDisplace * 8.0 + 0.5, 0.0, 1.0);
    vec3 color = mix(uColorA, uColorB, t);

    float fresnel = pow(1.0 - abs(dot(vNormal, vec3(0.0, 0.0, 1.0))), 2.0);
    color += uColorC * fresnel * 0.5;

    float pulse = sin(uTime * 3.0) * 0.1 + 0.9;
    color *= pulse;

    gl_FragColor = vec4(color, 1.0);
  }
`;


const ringVertexShader = `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const ringFragmentShader = `
  precision mediump float;

  uniform float uTime;
  uniform vec3  uColor;

  varying vec2 vUv;

  void main() {
    float angle      = atan(vUv.y - 0.5, vUv.x - 0.5);
    float normalized = (angle + 3.14159) / (2.0 * 3.14159);
    float streak     = mod(normalized + uTime * 0.3, 1.0);
    streak = pow(smoothstep(0.0, 0.15, streak) * smoothstep(0.35, 0.15, streak), 1.5);

    float dist = length(vUv - 0.5);
    float ring = smoothstep(0.48, 0.44, dist) * smoothstep(0.30, 0.36, dist);

    float alpha = ring * (0.3 + streak * 0.7);
    vec3  color = uColor + vec3(streak * 0.4);

    gl_FragColor = vec4(color, alpha);
  }
`;


const container   = document.querySelector('#ar-container');
const startButton = document.querySelector('#start-ar');
const stopButton  = document.querySelector('#stop-ar');
const statusText  = document.querySelector('#status-text');

let started    = false;
let mindarThree;
let renderer, scene, camera;
let sceneReady = false;
let satellites = [];


let holoMat, waveMat, ringMat;


const BOGOTA_CIELO   = new THREE.Color(0x00c9ff); 
const BOGOTA_TIERRA  = new THREE.Color(0xff7a18); 
const BOGOTA_GRAFITI = new THREE.Color(0xc8ff00); 
const BOGOTA_NOCHE   = new THREE.Color(0x1a0533); 


const setupScene = () => {
  if (sceneReady) return;

  scene.add(new THREE.AmbientLight(0xffffff, 0.4));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
  dirLight.position.set(2, 4, 2);
  scene.add(dirLight);

  const anchor = mindarThree.addAnchor(0);

  // 1. Plano holográfico (base sobre el target)
  holoMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime:   { value: 0.0 },
      uColorA: { value: BOGOTA_CIELO },
      uColorB: { value: BOGOTA_TIERRA },
    },
    vertexShader:   holoVertexShader,
    fragmentShader: holoFragmentShader,
    transparent:    true,
    side:           THREE.DoubleSide,
    depthWrite:     false,
  });

  const holoPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(1.2, 1.2),
    holoMat
  );
  holoPlane.rotation.x = -Math.PI / 2;
  holoPlane.position.y = 0.001;
  anchor.group.add(holoPlane);

  // 2. Esfera con shader de ondas (objeto central)
  waveMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime:      { value: 0.0 },
      uAmplitude: { value: 0.04 },
      uColorA:    { value: BOGOTA_NOCHE },
      uColorB:    { value: BOGOTA_CIELO },
      uColorC:    { value: BOGOTA_GRAFITI },
    },
    vertexShader:   waveVertexShader,
    fragmentShader: waveFragmentShader,
    side:           THREE.DoubleSide,
  });

  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(0.22, 64, 64),
    waveMat
  );
  sphere.position.set(0, 0.3, 0);
  anchor.group.add(sphere);

  // 3. Anillo orbital con shader de franja giratoria
  ringMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime:  { value: 0.0 },
      uColor: { value: BOGOTA_TIERRA },
    },
    vertexShader:   ringVertexShader,
    fragmentShader: ringFragmentShader,
    transparent:    true,
    side:           THREE.DoubleSide,
    depthWrite:     false,
  });

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.38, 0.03, 16, 80),
    ringMat
  );
  ring.rotation.x = Math.PI / 2.5;
  ring.position.set(0, 0.3, 0);
  anchor.group.add(ring);

  // 4. Esferas satélite (materiales estándar ligeros)
  const satColors = [0xff7a18, 0x00c9ff, 0xc8ff00];
  satellites = [];

  for (let i = 0; i < 3; i++) {
    const angle = (i / 3) * Math.PI * 2;
    const sat = new THREE.Mesh(
      new THREE.SphereGeometry(0.04, 16, 16),
      new THREE.MeshStandardMaterial({
        color:             satColors[i],
        emissive:          satColors[i],
        emissiveIntensity: 0.6,
        roughness:         0.2,
        metalness:         0.8,
      })
    );
    sat.userData.orbitAngle  = angle;
    sat.userData.orbitRadius = 0.42;
    sat.userData.orbitSpeed  = 0.8 + i * 0.2;
    sat.position.set(Math.cos(angle) * 0.42, 0.3, Math.sin(angle) * 0.42);
    anchor.group.add(sat);
    satellites.push(sat);
  }

  sceneReady = true;
};


const updateStatus = (msg) => { statusText.textContent = msg; };

const stopAR = () => {
  if (!started || !mindarThree) return;
  renderer.setAnimationLoop(null);
  mindarThree.stop();
  started = false;
  startButton.disabled = false;
  stopButton.disabled  = true;
  updateStatus('Cámara detenida.');
};

const startAR = async () => {
  if (started) return;
  startButton.disabled = true;
  stopButton.disabled  = true;
  updateStatus('Solicitando acceso a la cámara...');

  try {
    if (!mindarThree) {
      mindarThree = new MindARThree({
        container,
        imageTargetSrc: '../Assets/Targets/targets2.mind',
        uiScanning:  false,
        uiLoading:   false,
        maxTrack:    1,
        filterMinCF: 0.0001,
        filterBeta:  0.01,
      });
      ({ renderer, scene, camera } = mindarThree);
      setupScene();
    }

    await mindarThree.start();
    started = true;
    stopButton.disabled = false;
    updateStatus('Cámara activa. Apunta al target para ver el holograma.');

    renderer.setAnimationLoop(() => {
      if (!started) return;

      const t = performance.now() / 1000;

      // Actualizar tiempo en los tres shaders
      if (holoMat) holoMat.uniforms.uTime.value = t;
      if (waveMat) waveMat.uniforms.uTime.value  = t;
      if (ringMat) ringMat.uniforms.uTime.value  = t;

      // Animar satélites en órbita
      satellites.forEach((sat) => {
        sat.userData.orbitAngle += sat.userData.orbitSpeed * 0.016;
        const a = sat.userData.orbitAngle;
        const r = sat.userData.orbitRadius;
        sat.position.set(Math.cos(a) * r, 0.3, Math.sin(a) * r);
      });

      renderer.render(scene, camera);
    });

  } catch (error) {
    console.error(error);
    updateStatus('No se pudo iniciar. Usa localhost y acepta permisos de cámara.');
    startButton.disabled = false;
    stopButton.disabled  = true;
  }
};


startButton.addEventListener('click', startAR);
stopButton.addEventListener('click', stopAR);
stopButton.disabled = true;



