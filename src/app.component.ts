import { Component, ElementRef, ViewChild, AfterViewInit, OnDestroy, ChangeDetectionStrategy, HostListener, signal, computed } from '@angular/core';

// Declare Three.js and OrbitControls as they are loaded from a script tag.
declare const THREE: any;

type DisplayType = 'pressure' | 'thickness' | 'temperature';

interface BearingPhysics {
    values: Float32Array;
    stats: {
        maxPressure: number;
        minThickness: number;
        maxTemp: number;
    }
}

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
})
export class AppComponent implements AfterViewInit, OnDestroy {
  @ViewChild('rendererCanvas', { static: true })
  private rendererCanvas!: ElementRef<HTMLCanvasElement>;

  private scene!: any;
  private camera!: any;
  private renderer!: any;
  private controls!: any;
  private rotor!: any;
  private bearing1!: any;
  private bearing2!: any;
  private originalRotorPosition!: any;

  private animationFrameId: number | null = null;
  private clock = new THREE.Clock();


  // --- State Management with Signals ---
  rotationSpeed = signal(100); // RPM
  displayType = signal<DisplayType>('pressure');
  panelData = signal({
    maxPressure1: 0, maxPressure2: 0,
    minThickness1: 0, minThickness2: 0,
    temp1A: 0, temp1B: 0,
    temp2A: 0, temp2B: 0,
  });

  legendRange = signal({min: 0, max: 1});

  legendData = computed(() => {
    switch (this.displayType()) {
      case 'pressure':
        return { unit: 'Pressure (MPa)' };
      case 'thickness':
        return { unit: 'Thickness (μm)' };
      case 'temperature':
        return { unit: 'Temperature (°C)' };
    }
  });

  legendSteps = computed(() => {
      const steps = [];
      const { min, max } = this.legendRange();
      const range = max - min;
      const numSteps = 12;
      const color = new THREE.Color();

      for (let i = 0; i < numSteps; i++) {
          const fraction = 1 - (i / (numSteps - 1));
          const value = min + range * fraction;
          color.setHSL(0.7 * fraction, 1.0, 0.5);
          steps.push({
              value: value.toFixed(this.displayType() === 'pressure' ? 2 : 1),
              color: `rgb(${Math.round(color.r*255)}, ${Math.round(color.g*255)}, ${Math.round(color.b*255)})`
          });
      }
      return steps;
  });

  ngAfterViewInit(): void {
    this.initThree();
    this.createSceneContent();
    this.animate();
  }

  ngOnDestroy(): void {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
    }
    if (this.renderer) {
      this.renderer.dispose();
    }
    window.removeEventListener('resize', this.onWindowResize);
  }

  onSpeedChange(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    // Slider 0-100 maps to 0-4000 RPM
    this.rotationSpeed.set(Number(value) * 40);
  }

  onDisplayTypeChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value as DisplayType;
    this.displayType.set(value);
  }

  @HostListener('window:resize', ['$event'])
  onWindowResize() {
    const aspect = window.innerWidth / window.innerHeight;
    const frustumSize = 30; // Increased size to fit the longer rotor
    this.camera.left = frustumSize * aspect / -2;
    this.camera.right = frustumSize * aspect / 2;
    this.camera.top = frustumSize / 2;
    this.camera.bottom = frustumSize / -2;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  private initThree(): void {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xe0e0e0);

    const aspect = window.innerWidth / window.innerHeight;
    const frustumSize = 30; // Increased size
    this.camera = new THREE.OrthographicCamera(frustumSize * aspect / -2, frustumSize * aspect / 2, frustumSize / 2, frustumSize / -2, 0.1, 1000);
    this.camera.position.set(15, 12, 22);
    this.camera.lookAt(this.scene.position);

    this.renderer = new THREE.WebGLRenderer({ canvas: this.rendererCanvas.nativeElement, antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap; // Softer shadows

    this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.screenSpacePanning = true;
  }
  
  private createSceneContent(): void {
    // Enhanced Lighting
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.0));
    const directionalLight = new THREE.DirectionalLight(0xffffff, 1.5);
    directionalLight.position.set(10, 20, 15);
    directionalLight.castShadow = true;
    // Configure shadow camera for better quality
    directionalLight.shadow.mapSize.width = 2048;
    directionalLight.shadow.mapSize.height = 2048;
    directionalLight.shadow.camera.left = -20;
    directionalLight.shadow.camera.right = 20;
    directionalLight.shadow.camera.top = 20;
    directionalLight.shadow.camera.bottom = -20;
    this.scene.add(directionalLight);
    
    this.scene.add(new THREE.AxesHelper(5));
    this.rotor = this.createRotor();
    this.originalRotorPosition = this.rotor.position.clone();
    this.scene.add(this.rotor);

    const bearingPosition1 = new THREE.Vector3(-8, 0, 0);
    const bearingPosition2 = new THREE.Vector3(8, 0, 0);

    this.bearing1 = this.createBearing(bearingPosition1, 1);
    this.scene.add(this.bearing1);
    
    this.bearing2 = this.createBearing(bearingPosition2, 1);
    this.scene.add(this.bearing2);
  }

  private createRotor(): any {
    const rotorGroup = new THREE.Group();
    const shaftMaterial = new THREE.MeshStandardMaterial({ color: 0xcccccc, metalness: 0.8, roughness: 0.2 });
    
    // Doubled shaft length
    const shaftGeometry = new THREE.CylinderGeometry(0.5, 0.5, 24, 32);
    const shaft = new THREE.Mesh(shaftGeometry, shaftMaterial);
    shaft.rotation.z = Math.PI / 2;
    shaft.castShadow = true;
    rotorGroup.add(shaft);

    const diskMaterial = new THREE.MeshStandardMaterial({ color: 0xaaaaaa, metalness: 0.7, roughness: 0.3 });
    const diskGeometry = new THREE.CylinderGeometry(2.5, 2.5, 1, 64);
    const disk = new THREE.Mesh(diskGeometry, diskMaterial);
    disk.rotation.z = Math.PI / 2;
    disk.castShadow = true;
    rotorGroup.add(disk);

    const indicatorMaterial = new THREE.MeshStandardMaterial({ color: 0xff0000 });
    const indicatorGeometry = new THREE.CylinderGeometry(0.1, 0.1, 1.1, 16);
    const indicator = new THREE.Mesh(indicatorGeometry, indicatorMaterial);
    indicator.position.y = 2.4;
    indicator.rotation.z = Math.PI / 2;
    indicator.castShadow = true;
    rotorGroup.add(indicator);

    return rotorGroup;
  }
  
  private createBearing(position: any, length: number): any {
    const bearingGroup = new THREE.Group();
    const radius = 0.5;
    const radialSegments = 64;
    const heightSegments = 32;

    const geometry = new THREE.CylinderGeometry(radius, radius, length, radialSegments, heightSegments, true);
    geometry.userData.originalPositions = geometry.attributes.position.clone();
    geometry.userData.length = length; // Store length for physics
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(geometry.attributes.position.count * 3), 3));

    const surfaceMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide });
    const surfaceMesh = new THREE.Mesh(geometry, surfaceMaterial);
    bearingGroup.add(surfaceMesh);

    const wireframeMaterial = new THREE.MeshBasicMaterial({ color: 0x333333, wireframe: true, transparent: true, opacity: 0.15 });
    const wireframeMesh = new THREE.Mesh(geometry, wireframeMaterial);
    bearingGroup.add(wireframeMesh);
    
    const housingRadius = radius + 0.3;
    // Reverted housing to solid, transparent material
    const housingMaterial = new THREE.MeshStandardMaterial({ 
        color: 0xdaa520, 
        transparent: true, 
        opacity: 0.3,
        metalness: 0.4,
        roughness: 0.6
    });
    const housingGeometry = new THREE.CylinderGeometry(housingRadius, housingRadius, length, radialSegments, 1);
    const bearingHousing = new THREE.Mesh(housingGeometry, housingMaterial);
    bearingGroup.add(bearingHousing);

    bearingGroup.position.copy(position);
    bearingGroup.rotation.z = Math.PI / 2;
    return bearingGroup;
  }

  private createPedestal(position: any): any {
      const pedestalGroup = new THREE.Group();
      const pedestalHeight = 3.2; // Height from bearing bottom to ground plane
      const pedestalWidth = 2;   // Wider base
      const pedestalDepth = 2;   // Wider base
      
      const pedestalGeometry = new THREE.BoxGeometry(pedestalWidth, pedestalHeight, pedestalDepth);
      const pedestalMaterial = new THREE.MeshBasicMaterial({ color: 0x666666, wireframe: true, transparent: true, opacity: 0.5 });
      const pedestal = new THREE.Mesh(pedestalGeometry, pedestalMaterial);
      
      // Position the pedestal below the bearing
      pedestal.position.set(position.x, -0.8 - (pedestalHeight / 2), position.z);
      
      pedestalGroup.add(pedestal);
      return pedestalGroup;
  }

  private updateBearingVisualizations(rpm: number, elapsedTime: number): void {
    const type = this.displayType();

    // Pass 1: Calculate physics for both bearings
    const physics1 = this.calculateBearingPhysics(this.bearing1, rpm, elapsedTime, false);
    const physics2 = this.calculateBearingPhysics(this.bearing2, rpm, elapsedTime, true);

    // Update data panel
    this.panelData.set({
        maxPressure1: physics1.stats.maxPressure,
        maxPressure2: physics2.stats.maxPressure,
        minThickness1: physics1.stats.minThickness,
        minThickness2: physics2.stats.minThickness,
        temp1A: physics1.stats.maxTemp - 5 + Math.random(),
        temp1B: physics1.stats.maxTemp - 2 + Math.random(),
        temp2A: physics2.stats.maxTemp - 5 + Math.random(),
        temp2B: physics2.stats.maxTemp - 2 + Math.random(),
    });
    
    // Determine global min/max for the legend
    let min = Infinity, max = -Infinity;
    switch (type) {
        case 'pressure':
            min = 0; // Pressure starts at 0
            max = Math.max(physics1.stats.maxPressure, physics2.stats.maxPressure);
            break;
        case 'thickness':
            min = Math.min(physics1.stats.minThickness, physics2.stats.minThickness);
            max = Math.max(50 + (rpm / 4000) * 40, 55); // Estimate max thickness based on speed
            break;
        case 'temperature':
            min = 40; // Base temperature
            max = Math.max(physics1.stats.maxTemp, physics2.stats.maxTemp);
            break;
    }
    this.legendRange.set({ min: min, max: max });

    // Pass 2: Apply visuals using the calculated physics and global range
    this.applyBearingVisuals(this.bearing1, physics1, this.legendRange());
    this.applyBearingVisuals(this.bearing2, physics2, this.legendRange());
  }
  
  private calculateBearingPhysics(bearingGroup: any, rpm: number, elapsedTime: number, isBearing2: boolean) {
    const geometry = bearingGroup.children[0].geometry;
    const originalPositions = geometry.userData.originalPositions;
    const radius = 0.5;
    const length = geometry.userData.length;
    
    const speedFactor = Math.min(rpm / 4000, 1.0);
    const values = new Float32Array(originalPositions.count);
    let maxPressure = 0, minThickness = Infinity, maxTemp = 0;

    for (let i = 0; i < originalPositions.count; i++) {
        const ox = originalPositions.getX(i);
        const oy = originalPositions.getY(i);

        const cosTheta = ox / radius;
        const basePressureNorm = this.getPressure(cosTheta, oy, length);
        
        const shimmer = 1.0 + Math.sin(elapsedTime * 5 + i * 0.5) * 0.05 * (1 + speedFactor);

        const pressure = basePressureNorm * (1.5 + speedFactor * 10.0) * (isBearing2 ? 1.05 : 1.0) * shimmer;
        const thickness = 5.0 + (1 - basePressureNorm) * 45.0 + speedFactor * 40.0 * shimmer;
        const temperature = 40.0 + basePressureNorm * 35.0 + speedFactor * 60.0 * shimmer;

        if (pressure > maxPressure) maxPressure = pressure;
        if (thickness < minThickness) minThickness = thickness;
        if (temperature > maxTemp) maxTemp = temperature;

        switch(this.displayType()) {
            case 'pressure': values[i] = pressure; break;
            case 'thickness': values[i] = thickness; break;
            case 'temperature': values[i] = temperature; break;
        }
    }
    return { values, stats: { maxPressure, minThickness, maxTemp } };
  }

  private applyBearingVisuals(bearingGroup: any, physics: { values: Float32Array }, range: { min: number; max: number }) {
    const surfaceMesh = bearingGroup.children[0];
    const geometry = surfaceMesh.geometry;
    const positions = geometry.attributes.position;
    const colors = geometry.attributes.color;
    const originalPositions = geometry.userData.originalPositions;
    const color = new THREE.Color();
    const type = this.displayType();
    
    for (let i = 0; i < positions.count; i++) {
        const value = physics.values[i];
        const normalizedValue = (range.max > range.min) ? (value - range.min) / (range.max - range.min) : 0;
        
        let displacementFactor = 0;
        switch(type) {
            case 'pressure': displacementFactor = 0.375; break;
            case 'thickness': displacementFactor = 0.1; break;
            case 'temperature': displacementFactor = 0.2; break;
        }

        const ox = originalPositions.getX(i);
        const oy = originalPositions.getY(i);
        const oz = originalPositions.getZ(i);

        const normal = new THREE.Vector3(ox, 0, oz).normalize();
        const displacement = normal.multiplyScalar(normalizedValue * displacementFactor);
        positions.setXYZ(i, ox + displacement.x, oy, oz + displacement.z);
        
        color.setHSL(0.7 * (1 - normalizedValue), 1.0, 0.5);
        colors.setXYZ(i, color.r, color.g, color.b);
    }
    positions.needsUpdate = true;
    colors.needsUpdate = true;
    geometry.computeVertexNormals();
  }

  private getPressure(cosTheta: number, z: number, length: number): number {
    const pressureMagnitude = Math.max(0, -cosTheta);
    const axialFalloff = Math.max(0, 1 - Math.pow((2 * z) / length, 2));
    return pressureMagnitude * axialFalloff;
  }

  private animate(): void {
    this.animationFrameId = requestAnimationFrame(() => this.animate());
    this.controls.update();
    
    const elapsedTime = this.clock.getElapsedTime();
    const rpm = this.rotationSpeed();
    const visualRotationSpeed = rpm * 0.00005;

    if (this.rotor) {
        this.rotor.rotation.x += visualRotationSpeed;
        
        const vibration = (rpm / 4000) * 0.05;
        this.rotor.position.y = this.originalRotorPosition.y + (Math.random() - 0.5) * vibration;
        this.rotor.position.z = this.originalRotorPosition.z + (Math.random() - 0.5) * vibration;
    }
    
    this.updateBearingVisualizations(rpm, elapsedTime);

    this.renderer.render(this.scene, this.camera);
  }
}
