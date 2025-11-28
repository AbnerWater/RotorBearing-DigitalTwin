import { Component, ElementRef, ViewChild, AfterViewInit, OnDestroy, ChangeDetectionStrategy, HostListener, signal, computed, effect } from '@angular/core';

// FIX: Declare THREE as a variable and a namespace to allow both value access (new THREE.Scene())
// and type access (private scene: THREE.Scene). Empty classes are sufficient to resolve type errors.
// This resolves the "Cannot find namespace 'THREE'" errors.
declare var THREE: any;
declare namespace THREE {
    class Scene {}
    class OrthographicCamera {}
    class WebGLRenderer {}
    class OrbitControls {}
    class Group {}
    class Vector3 {}
    class Quaternion {}
    class Clock {}
    class Color {}
    class HemisphereLight {}
    class DirectionalLight {}
    class AxesHelper {}
    class STLLoader {}
    class MeshStandardMaterial {}
    class CylinderGeometry {}
    class Mesh {}
    class LineBasicMaterial {}
    class EdgesGeometry {}
    class LineSegments {}
    class Float32BufferAttribute {}
    class MeshBasicMaterial {}
}

// Declare D3.js as it is loaded from a script tag.
declare const d3: any;

type DisplayType = 'pressure' | 'thickness' | 'temperature';
type DisplayStyle = 'shaded' | 'shaded-edges' | 'wireframe' | 'transparent';

interface BearingConfig {
    position: { x: number, y: number, z: number };
    axis: { x: number, y: number, z: number };
    diameter: number;
    width: number;
    loadAngle: number;
    padCount: number;
    padAngle: number;
}
interface RotorConfig {
    type: 'default' | 'stl';
    file: File | null;
    color: string;
    rotationAxis: { x: number, y: number, z: number };
}
interface SceneSettings {
    rotor: RotorConfig;
    bearings: BearingConfig[];
}

// Function to safely serialize settings for saving (omits File object)
const serializeSettings = (settings: SceneSettings): string => {
    const replacer = (key: string, value: any) => {
        if (key === 'file') return undefined;
        return value;
    };
    return JSON.stringify(settings, replacer, 2);
};

const getDefaultSettings = (): SceneSettings => ({
    rotor: { type: 'default', file: null, color: '#cccccc', rotationAxis: { x: 1, y: 0, z: 0 } },
    bearings: [
      { position: { x: -8, y: 0, z: 0 }, axis: { x: 1, y: 0, z: 0 }, diameter: 1.0, width: 1.0, loadAngle: 0, padCount: 0, padAngle: 0 },
      { position: { x: 8, y: 0, z: 0 }, axis: { x: 1, y: 0, z: 0 }, diameter: 1.0, width: 1.0, loadAngle: 0, padCount: 0, padAngle: 0 }
    ]
});


@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
})
export class AppComponent implements AfterViewInit, OnDestroy {
  @ViewChild('rendererCanvas', { static: true })
  private rendererCanvas!: ElementRef<HTMLCanvasElement>;
  @ViewChild('projectFileInput')
  private projectFileInput!: ElementRef<HTMLInputElement>;
  @ViewChild('pressureChart') private pressureChartEl!: ElementRef<SVGElement>;
  @ViewChild('thicknessChart') private thicknessChartEl!: ElementRef<SVGElement>;
  @ViewChild('tempChart') private tempChartEl!: ElementRef<SVGElement>;

  private scene!: THREE.Scene;
  private camera!: THREE.OrthographicCamera;
  private renderer!: THREE.WebGLRenderer;
  private controls!: THREE.OrbitControls;
  private rotor!: THREE.Group;
  private bearings: THREE.Group[] = [];
  private originalRotorPosition!: THREE.Vector3;
  private axisScene!: THREE.Scene;
  private axisCamera!: THREE.OrthographicCamera;

  private animationFrameId: number | null = null;
  private clock = new THREE.Clock();

  // --- State Management with Signals ---
  isPlaying = signal(true);
  isSettingsVisible = signal(false);
  isChartVisible = signal(true);
  rotationSpeed = signal(100); // RPM
  displayType = signal<DisplayType>('pressure');
  displayStyle = signal<DisplayStyle>('shaded');
  
  // Settings that drive the scene
  settings = signal<SceneSettings>(getDefaultSettings());
  
  // A snapshot of the last saved/applied state to check for unsaved changes
  savedSettings = signal<SceneSettings>(this.settings());

  // Temporary state for the settings form
  settingsForm = signal<SceneSettings>(this.settings());
  
  isDirty = computed(() => serializeSettings(this.settingsForm()) !== serializeSettings(this.savedSettings()));

  panelData = signal<any[]>([]);
  legendRange = signal({min: 0, max: 1});

  legendData = computed(() => {
    switch (this.displayType()) {
      case 'pressure': return { unit: '压力 (MPa)' };
      case 'thickness': return { unit: '厚度 (μm)' };
      case 'temperature': return { unit: '温度 (°C)' };
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

  // --- Charting Properties ---
  private readonly MAX_CHART_POINTS = 200;
  chartColors = ['#34d399', '#fb923c', '#60a5fa', '#f87171', '#a78bfa', '#fbbf24', '#4ade80', '#2dd4bf', '#818cf8', '#f472b6'];

  private chartData = {
      pressure: [] as { time: number; value: number }[][],
      thickness: [] as { time: number; value: number }[][],
      temperature: [] as { time: number; value: number }[][],
  };
  private charts: { [key: string]: any } = {};

  constructor() {
    // Re-initialize chart data structure when bearing count changes
    effect(() => {
      const bearingCount = this.settings().bearings.length;
      this.chartData.pressure = Array.from({ length: bearingCount }, () => []);
      this.chartData.thickness = Array.from({ length: bearingCount }, () => []);
      this.chartData.temperature = Array.from({ length: bearingCount }, () => []);
    });

    effect(() => {
      if (this.isChartVisible()) {
        // Use timeout to allow Angular to render the SVG elements and for them to get dimensions
        setTimeout(() => this.initCharts(), 0);
      } else {
        // Clear chart instances when they are hidden as their DOM elements are destroyed
        this.charts = {};
      }
    });
  }

  async ngAfterViewInit(): Promise<void> {
    this.initThree();
    await this.rebuildScene();
    this.animate();
  }

  ngOnDestroy(): void {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
    }
    this.cleanupScene();
    if (this.renderer) this.renderer.dispose();
    window.removeEventListener('resize', this.onWindowResize);
  }

  // --- UI Event Handlers ---

  togglePlayPause(): void {
    this.isPlaying.set(!this.isPlaying());
  }

  toggleChartView(): void {
    this.isChartVisible.set(!this.isChartVisible());
  }
  
  toggleSettings(): void {
    // Deep copy to prevent direct mutation of the original signal
    this.settingsForm.set(JSON.parse(serializeSettings(this.settings())));
    this.isSettingsVisible.set(true);
  }
  
  cancelSettings(): void {
      if (this.isDirty() && !confirm('您有未保存的更改。确定要放弃吗?')) {
          return;
      }
      this.isSettingsVisible.set(false);
  }

  onSpeedChange(event: Event): void {
    this.rotationSpeed.set(Number((event.target as HTMLInputElement).value));
  }

  onDisplayTypeChange(event: Event): void {
    this.displayType.set((event.target as HTMLSelectElement).value as DisplayType);
  }
  
  onDisplayStyleChange(event: Event): void {
    this.displayStyle.set((event.target as HTMLSelectElement).value as DisplayStyle);
    this.applyDisplayStyle();
  }
  
  // --- Settings Form Update Handlers (Refactored) ---

  private getNumberValue(event: Event): number {
      const value = (event.target as HTMLInputElement).value;
      const numValue = Number(value);
      // Ensure empty strings or non-numeric input don't result in an unwanted 0
      return (typeof value === 'string' && !isNaN(numValue) && value.trim() !== '') ? numValue : 0;
  }

  updateRotorType(type: 'default' | 'stl'): void {
      this.settingsForm.update(current => ({
          ...current,
          rotor: { ...current.rotor, type, file: type === 'default' ? null : current.rotor.file }
      }));
  }

  onRotorFileSelected(event: Event): void {
      const file = (event.target as HTMLInputElement).files?.[0] ?? null;
      this.settingsForm.update(current => ({
          ...current,
          rotor: { ...current.rotor, file }
      }));
  }

  updateRotorColor(event: Event): void {
      const color = (event.target as HTMLInputElement).value;
      this.settingsForm.update(current => ({
          ...current,
          rotor: { ...current.rotor, color }
      }));
  }

  updateRotorAxis(axis: 'x' | 'y' | 'z', event: Event): void {
      const value = this.getNumberValue(event);
      this.settingsForm.update(current => ({
          ...current,
          rotor: {
              ...current.rotor,
              rotationAxis: { ...current.rotor.rotationAxis, [axis]: value }
          }
      }));
  }
  
  updateBearingValue(bearingIndex: number, key: keyof Omit<BearingConfig, 'position' | 'axis'>, event: Event): void {
      const value = this.getNumberValue(event);
      this.settingsForm.update(current => {
          const newBearings = [...current.bearings];
          newBearings[bearingIndex] = { ...newBearings[bearingIndex], [key]: value };
          return { ...current, bearings: newBearings };
      });
  }

  updateBearingVector(bearingIndex: number, key: 'position' | 'axis', axis: 'x' | 'y' | 'z', event: Event): void {
      const value = this.getNumberValue(event);
      this.settingsForm.update(current => {
          const newBearings = [...current.bearings];
          const bearing = newBearings[bearingIndex];
          newBearings[bearingIndex] = {
              ...bearing,
              [key]: { ...(bearing[key]), [axis]: value }
          };
          return { ...current, bearings: newBearings };
      });
  }

  addBearing(): void {
    this.settingsForm.update(current => {
      if (current.bearings.length >= 10) return current;
      const newBearing: BearingConfig = {
        position: { x: 10, y: 0, z: 0 },
        axis: { x: 1, y: 0, z: 0 },
        diameter: 1.0,
        width: 1.0,
        loadAngle: 0,
        padCount: 0,
        padAngle: 0
      };
      return { ...current, bearings: [...current.bearings, newBearing] };
    });
  }

  removeBearing(index: number): void {
    this.settingsForm.update(current => {
      if (current.bearings.length <= 1) return current;
      const newBearings = current.bearings.filter((_, i) => i !== index);
      return { ...current, bearings: newBearings };
    });
  }

  applySettings(): void {
      const newSettings = this.settingsForm();
      this.settings.set(newSettings);
      this.savedSettings.set(newSettings);
      this.rebuildScene();
      this.isSettingsVisible.set(false);
  }

  setView(view: string): void {
    const distance = 35;
    this.controls.target.set(0, 0, 0);

    switch (view) {
        case 'iso':
            this.camera.position.set(distance / 1.732, distance / 1.732, distance / 1.732);
            break;
        case 'front':
            this.camera.position.set(0, 0, distance);
            break;
        case 'back':
            this.camera.position.set(0, 0, -distance);
            break;
        case 'top':
            this.camera.position.set(0, distance, 0);
            break;
        case 'bottom':
            this.camera.position.set(0, -distance, 0);
            break;
        case 'left':
            this.camera.position.set(-distance, 0, 0);
            break;
        case 'right':
            this.camera.position.set(distance, 0, 0);
            break;
    }
    
    if (view === 'top' || view === 'bottom') {
        this.camera.up.set(0, 0, 1);
    } else {
        this.camera.up.set(0, 1, 0);
    }
    
    this.camera.lookAt(0, 0, 0);
    this.controls.update();
  }
  
  // --- Project Management ---
  private promptIfDirty(action: () => void): void {
    if (this.isDirty() && !confirm('您有未保存的更改将会丢失。确定要继续吗?')) {
        return;
    }
    action();
  }

  newProject(): void {
    this.promptIfDirty(() => {
        const defaults = getDefaultSettings();
        this.settings.set(defaults);
        this.settingsForm.set(defaults);
        this.savedSettings.set(defaults);
        this.rebuildScene();
    });
  }

  openProject(): void {
    this.promptIfDirty(() => {
        this.projectFileInput.nativeElement.click();
    });
  }

  onProjectFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
        try {
            const loadedSettings = JSON.parse(reader.result as string);
            // Basic validation
            if (loadedSettings.rotor && loadedSettings.bearings) {
                const newSettings: SceneSettings = { ...getDefaultSettings(), ...loadedSettings };
                newSettings.rotor.file = null; // File handle must be re-established by user
                
                this.settings.set(newSettings);
                this.settingsForm.set(newSettings);
                this.savedSettings.set(newSettings);
                this.rebuildScene();
                alert('项目加载成功。如果您使用的是自定义STL模型，请重新选择文件。');
            } else {
                throw new Error('无效的项目文件结构。');
            }
        } catch (e) {
            console.error('项目加载失败:', e);
            alert('错误：无法读取或解析项目文件。');
        }
    };
    reader.readAsText(file);
    input.value = ''; // Reset for next open
  }
  
  saveProject(): void {
    try {
        const settingsJson = serializeSettings(this.settingsForm());
        const blob = new Blob([settingsJson], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'rotor-project.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        this.savedSettings.set(this.settingsForm()); // Mark current state as saved
    } catch (e) {
        console.error('项目保存失败:', e);
        alert('保存项目时发生错误。');
    }
  }

  @HostListener('window:resize', ['$event'])
  onWindowResize() {
    const aspect = window.innerWidth / window.innerHeight;
    const frustumSize = 30;
    this.camera.left = frustumSize * aspect / -2;
    this.camera.right = frustumSize * aspect / 2;
    this.camera.top = frustumSize / 2;
    this.camera.bottom = frustumSize / -2;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  private initThree(): void {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a0f1a); // Dark blue background

    const aspect = window.innerWidth / window.innerHeight;
    const frustumSize = 30;
    this.camera = new THREE.OrthographicCamera(frustumSize * aspect / -2, frustumSize * aspect / 2, frustumSize / 2, frustumSize / -2, 0.1, 1000);
    this.camera.position.set(15, 12, 22);
    this.camera.lookAt(this.scene.position);

    this.renderer = new THREE.WebGLRenderer({ canvas: this.rendererCanvas.nativeElement, antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    
    this.scene.add(new THREE.HemisphereLight(0xadd8e6, 0x444444, 1.5)); // Soft blueish light
    const directionalLight = new THREE.DirectionalLight(0xffffff, 1.5);
    directionalLight.position.set(10, 20, 15);
    directionalLight.castShadow = true;
    directionalLight.shadow.mapSize.width = 2048;
    directionalLight.shadow.mapSize.height = 2048;
    this.scene.add(directionalLight);
    
    // Axis indicator
    this.axisScene = new THREE.Scene();
    const axisHelper = new THREE.AxesHelper(5);
    this.axisScene.add(axisHelper);
    this.axisCamera = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 100);
  }

  private initCharts(): void {
    if (this.charts.pressure) return;
    if (!this.pressureChartEl || !this.thicknessChartEl || !this.tempChartEl) {
        setTimeout(() => this.initCharts(), 50);
        return;
    }
    
    const bearingCount = this.settings().bearings.length;
    const colors = this.chartColors.slice(0, bearingCount);

    const pressureChart = this.setupChart(this.pressureChartEl, colors);
    const thicknessChart = this.setupChart(this.thicknessChartEl, colors);
    const tempChart = this.setupChart(this.tempChartEl, colors);
    
    if (!pressureChart || !thicknessChart || !tempChart) {
        setTimeout(() => this.initCharts(), 50);
        return;
    }

    this.charts.pressure = pressureChart;
    this.charts.thickness = thicknessChart;
    this.charts.temperature = tempChart;
  }

  private setupChart(elementRef: ElementRef, colors: string[]) {
    const el = elementRef.nativeElement;
    const margin = { top: 10, right: 20, bottom: 20, left: 35 };
    const width = el.clientWidth - margin.left - margin.right;
    const height = el.clientHeight - margin.top - margin.bottom;

    if (width <= 0 || height <= 0) return null;

    const d3el = d3.select(el);
    d3el.selectAll('*').remove(); 

    const svg = d3el
        .append("g")
        .attr("transform", `translate(${margin.left},${margin.top})`);
    
    const x = d3.scaleLinear().range([0, width]);
    const y = d3.scaleLinear().range([height, 0]);

    svg.append("g")
        .attr("class", "x-axis")
        .attr("transform", `translate(0,${height})`)
        .call(d3.axisBottom(x).ticks(3).tickFormat(() => ''));

    svg.append("g")
        .attr("class", "y-axis")
        .call(d3.axisLeft(y).ticks(4).tickSize(-width))
        .selectAll(".tick line")
        .attr("stroke", "#475569");
    
    svg.selectAll(".domain").remove();

    const lines = colors.map(color => 
      svg.append("path").attr("fill", "none").attr("stroke", color).attr("stroke-width", 2)
    );

    return { svg, x, y, width, height, lines };
  }
  
  private updateCharts(elapsedTime: number): void {
      if (!this.isChartVisible() || Object.keys(this.charts).length === 0) return;

      const updateSingleChart = (chart: any, dataSets: any[][]) => {
          if (!chart || !dataSets.length || dataSets[0].length < 2) return;

          const lastTime = dataSets[0][dataSets[0].length - 1].time;
          const firstTime = dataSets[0][0].time;
          chart.x.domain([firstTime, lastTime]);

          const allValues = dataSets.flat().map(d => d.value);
          const yDomain = d3.extent(allValues);

          if (yDomain[0] !== undefined && yDomain[1] !== undefined) {
              const padding = (yDomain[1] - yDomain[0]) * 0.1 || 1;
              chart.y.domain([yDomain[0] - padding, yDomain[1] + padding]);
          }

          chart.svg.select(".y-axis").transition().duration(50).call(d3.axisLeft(chart.y).ticks(4).tickSize(-chart.width));
          
          const lineGenerator = d3.line()
              .x((d: any) => chart.x(d.time))
              .y((d: any) => chart.y(d.value));

          chart.lines.forEach((line: any, index: number) => {
              line.attr("d", lineGenerator(dataSets[index]));
          });
      };

      updateSingleChart(this.charts.pressure, this.chartData.pressure);
      updateSingleChart(this.charts.thickness, this.chartData.thickness);
      updateSingleChart(this.charts.temperature, this.chartData.temperature);
  }

  private cleanupScene(): void {
      const toRemove = [this.rotor, ...this.bearings];
      toRemove.forEach(obj => {
          if (obj) {
              this.scene.remove(obj);
              obj.traverse((child: any) => {
                  if (child.geometry) child.geometry.dispose();
                  if (child.material) {
                    if (Array.isArray(child.material)) {
                        child.material.forEach((m: any) => m.dispose());
                    } else {
                        child.material.dispose();
                    }
                  }
              });
          }
      });
      this.rotor = null!;
      this.bearings = [];
  }

  private async rebuildScene(): Promise<void> {
    this.cleanupScene();
    const settings = this.settings();
    try {
        this.rotor = await this.createRotor(settings.rotor);
        this.originalRotorPosition = this.rotor.position.clone();
        this.scene.add(this.rotor);

        this.bearings = settings.bearings.map(bearingConfig => {
            const bearing = this.createBearing(bearingConfig);
            this.scene.add(bearing);
            return bearing;
        });

        this.applyDisplayStyle();
    } catch(e) {
        console.error("Failed to build scene:", e);
        if (settings.rotor.type === 'stl') {
             alert("加载STL模型时出错。请确保文件有效并重试。");
        }
    }
  }

  private createDefaultRotor(config: RotorConfig): THREE.Group {
    const rotorGroup = new THREE.Group();
    const shaftMaterial = new THREE.MeshStandardMaterial({ color: config.color, metalness: 0.8, roughness: 0.2 });
    shaftMaterial.userData = { originalOpacity: 1.0 };
    const shaftGeometry = new THREE.CylinderGeometry(0.5, 0.5, 24, 32);
    const shaft = new THREE.Mesh(shaftGeometry, shaftMaterial);
    shaft.rotation.z = Math.PI / 2;
    shaft.castShadow = true;
    shaft.userData.isStylable = true;
    rotorGroup.add(shaft);

    const diskMaterial = new THREE.MeshStandardMaterial({ color: config.color, metalness: 0.7, roughness: 0.3 });
    diskMaterial.userData = { originalOpacity: 1.0 };
    const diskGeometry = new THREE.CylinderGeometry(2.5, 2.5, 1, 64);
    const disk = new THREE.Mesh(diskGeometry, diskMaterial);
    disk.rotation.z = Math.PI / 2;
    disk.castShadow = true;
    disk.userData.isStylable = true;
    rotorGroup.add(disk);
    
    const indicatorMaterial = new THREE.MeshStandardMaterial({ color: 0xff0000 });
    const indicatorGeometry = new THREE.CylinderGeometry(0.1, 0.1, 1.1, 16);
    const indicator = new THREE.Mesh(indicatorGeometry, indicatorMaterial);
    indicator.position.y = 2.4;
    indicator.rotation.z = Math.PI / 2;
    indicator.castShadow = true;
    rotorGroup.add(indicator);

    // Add edges for stylable parts
    const lineMaterial = new THREE.LineBasicMaterial({ color: 0x000000, linewidth: 2 });
    
    const shaftEdges = new THREE.EdgesGeometry(shaft.geometry);
    const shaftLine = new THREE.LineSegments(shaftEdges, lineMaterial);
    shaftLine.rotation.z = Math.PI / 2;
    rotorGroup.add(shaftLine);

    const diskEdges = new THREE.EdgesGeometry(disk.geometry);
    const diskLine = new THREE.LineSegments(diskEdges, lineMaterial);
    diskLine.rotation.z = Math.PI / 2;
    rotorGroup.add(diskLine);

    return rotorGroup;
  }
  
  private async createRotor(config: RotorConfig): Promise<THREE.Group> {
    if (config.type === 'stl' && config.file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (event) => {
                try {
                    const contents = event.target?.result as ArrayBuffer;
                    if (!contents) {
                        return reject('File read error');
                    }
                    const loader = new THREE.STLLoader();
                    const geometry = loader.parse(contents);
                    geometry.center();

                    const material = new THREE.MeshStandardMaterial({ color: config.color, metalness: 0.8, roughness: 0.2 });
                    material.userData = { originalOpacity: 1.0 };
                    const mesh = new THREE.Mesh(geometry, material);
                    mesh.castShadow = true;
                    mesh.userData.isStylable = true;
                    
                    const rotorGroup = new THREE.Group();
                    rotorGroup.add(mesh);
                    
                    const lineMaterial = new THREE.LineBasicMaterial({ color: 0x000000, linewidth: 2 });
                    const edges = new THREE.EdgesGeometry(geometry);
                    const line = new THREE.LineSegments(edges, lineMaterial);
                    rotorGroup.add(line);

                    resolve(rotorGroup);
                } catch (e) {
                    reject(e);
                }
            };
            reader.onerror = (error) => reject(error);
            reader.readAsArrayBuffer(config.file);
        });
    } else {
        return Promise.resolve(this.createDefaultRotor(config));
    }
  }
  
  private createBearing(config: BearingConfig): THREE.Group {
    const { position, axis, diameter, width } = config;
    const bearingGroup = new THREE.Group();
    const radius = diameter / 2;
    const radialSegments = 64;
    const heightSegments = 32;

    const geometry = new THREE.CylinderGeometry(radius, radius, width, radialSegments, heightSegments, true);
    geometry.userData = { 
        originalPositions: geometry.attributes.position.clone(),
        width: width,
        radius: radius
    };
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(geometry.attributes.position.count * 3), 3));

    const surfaceMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide });
    const surfaceMesh = new THREE.Mesh(geometry, surfaceMaterial);
    bearingGroup.add(surfaceMesh);

    const wireframeMesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: 0x333333, wireframe: true, transparent: true, opacity: 0.15 }));
    bearingGroup.add(wireframeMesh);
    
    const housingRadius = radius + 0.3;
    const housingMaterial = new THREE.MeshStandardMaterial({ color: 0xdaa520, transparent: true, opacity: 0.3, metalness: 0.4, roughness: 0.6 });
    housingMaterial.userData = { originalOpacity: 0.3 };
    const housingGeometry = new THREE.CylinderGeometry(housingRadius, housingRadius, width, radialSegments, 1);
    const bearingHousing = new THREE.Mesh(housingGeometry, housingMaterial);
    bearingHousing.userData.isStylable = true;
    bearingGroup.add(bearingHousing);

    const lineMaterial = new THREE.LineBasicMaterial({ color: 0x333333, linewidth: 1 });
    const housingEdges = new THREE.EdgesGeometry(housingGeometry);
    const housingLine = new THREE.LineSegments(housingEdges, lineMaterial);
    bearingGroup.add(housingLine);

    bearingGroup.position.set(position.x, position.y, position.z);
    
    const defaultAxis = new THREE.Vector3(0, 1, 0); 
    const targetAxis = new THREE.Vector3(axis.x, axis.y, axis.z).normalize();
    const quaternion = new THREE.Quaternion().setFromUnitVectors(defaultAxis, targetAxis);
    bearingGroup.quaternion.copy(quaternion);
    
    return bearingGroup;
  }

  private applyDisplayStyle(): void {
    const style = this.displayStyle();
    const objectsToStyle = [this.rotor, ...this.bearings];

    objectsToStyle.forEach(obj => {
        if (!obj) return;
        
        obj.traverse((child: any) => {
            if (child.isMesh && child.userData.isStylable) {
                const material = child.material;
                if (material.userData.originalOpacity === undefined) {
                    material.userData.originalOpacity = material.opacity;
                }
                
                material.wireframe = style === 'wireframe';

                switch(style) {
                    case 'shaded':
                    case 'shaded-edges':
                        material.transparent = material.userData.originalOpacity < 1.0;
                        material.opacity = material.userData.originalOpacity;
                        break;
                    case 'wireframe':
                        material.transparent = true;
                        material.opacity = 0.25;
                        break;
                    case 'transparent':
                        material.transparent = true;
                        material.opacity = 0.5;
                        break;
                }
            }
            if (child.isLineSegments) {
                child.visible = (style === 'shaded-edges');
            }
        });
    });
  }

  private updateBearingVisualizations(rpm: number, elapsedTime: number): void {
    if (!this.bearings.length) return;
    const type = this.displayType();
    const settings = this.settings();

    const allPhysics = settings.bearings.map((bearingConfig, i) => 
        this.calculateBearingPhysics(this.bearings[i], rpm, elapsedTime, bearingConfig)
    );

    const newPanelData = allPhysics.map(p => {
        const tempA = p.stats.maxTemp - 5 + Math.random();
        return {
            maxPressure: p.stats.maxPressure,
            minThickness: p.stats.minThickness,
            tempA: tempA,
            tempB: p.stats.maxTemp - 2 + Math.random(),
        };
    });
    this.panelData.set(newPanelData);
    
    const now = elapsedTime;
    allPhysics.forEach((physics, i) => {
        this.chartData.pressure[i]?.push({ time: now, value: physics.stats.maxPressure });
        this.chartData.thickness[i]?.push({ time: now, value: physics.stats.minThickness });
        this.chartData.temperature[i]?.push({ time: now, value: newPanelData[i].tempA });

        if (this.chartData.pressure[i]?.length > this.MAX_CHART_POINTS) {
            this.chartData.pressure[i].shift();
            this.chartData.thickness[i].shift();
            this.chartData.temperature[i].shift();
        }
    });
    
    this.updateCharts(elapsedTime);

    let min = Infinity, max = -Infinity;
    const allStats = allPhysics.map(p => p.stats);
    switch (type) {
        case 'pressure': min = 0; max = Math.max(...allStats.map(s => s.maxPressure), 0); break;
        case 'thickness': min = Math.min(...allStats.map(s => s.minThickness), Infinity); max = Math.max(50 + (rpm / 4000) * 40, 55); break;
        case 'temperature': min = 40; max = Math.max(...allStats.map(s => s.maxTemp), 40); break;
    }
    this.legendRange.set({ min: min, max: max > min ? max : min + 1 });
    
    allPhysics.forEach((physics, i) => {
        this.applyBearingVisuals(this.bearings[i], physics, this.legendRange());
    });
  }
  
  private calculateBearingPhysics(bearingGroup: THREE.Group, rpm: number, elapsedTime: number, config: BearingConfig) {
    const geometry = (bearingGroup.children[0] as THREE.Mesh).geometry;
    const { originalPositions, width } = geometry.userData;
    
    const speedFactor = Math.pow(Math.min(rpm / 4000, 1.0), 1.5);
    const values = new Float32Array(originalPositions.count);
    let maxPressure = 0, minThickness = Infinity, maxTemp = 0;

    for (let i = 0; i < originalPositions.count; i++) {
        const ox = originalPositions.getX(i);
        const oy = originalPositions.getY(i);
        const oz = originalPositions.getZ(i);

        const theta = Math.atan2(oz, ox);
        
        const pressureMagnitude = this.getPressureMagnitude(theta, config);
        const axialFalloff = Math.max(0, 1 - Math.pow((2 * oy) / width, 2));
        const basePressureNorm = pressureMagnitude * axialFalloff;
        
        const shimmer = 1.0 + Math.sin(elapsedTime * 8 + i * 0.5) * 0.08 * (1 + speedFactor);
        const pressure = basePressureNorm * (2.0 + speedFactor * 15.0) * shimmer;
        const thickness = (5.0 + (1 - basePressureNorm) * 50.0) + (speedFactor * 60.0) * shimmer;
        const temperature = 40.0 + (basePressureNorm * 40.0) + (speedFactor * 75.0) * shimmer;

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
  
  private getPressureMagnitude(theta: number, config: BearingConfig): number {
    const { padCount, padAngle, loadAngle } = config;
    const loadAngleRad = loadAngle * Math.PI / 180;

    // Case 1: Full 360-degree bearing (padCount is 0 or invalid)
    if (!padCount || !padAngle || padAngle <= 0 || padAngle >= 360) {
        // Use half-Sommerfeld approximation for a full bearing.
        // Pressure is positive in the converging wedge, approx 180 degrees.
        return Math.max(0, -Math.cos(theta - loadAngleRad));
    }
    
    // Case 2: Tilted-pad bearing
    const normalizedTheta = theta < 0 ? theta + 2 * Math.PI : theta; // Range [0, 2*PI]
    const padAngleRad = padAngle * Math.PI / 180;
    const totalPadAngleRad = padCount * padAngleRad;

    // Fallback if total pad angle is nonsensical
    if (totalPadAngleRad >= 2 * Math.PI) {
        return Math.max(0, -Math.cos(theta - loadAngleRad));
    }
    
    const gapAngleRad = (2 * Math.PI - totalPadAngleRad) / padCount;
    const segmentAngleRad = padAngleRad + gapAngleRad;

    // Find which segment we are in
    const segmentIndex = Math.floor(normalizedTheta / segmentAngleRad);
    const angleInSegment = normalizedTheta - (segmentIndex * segmentAngleRad);

    // If the angle is in a gap, pressure is zero.
    if (angleInSegment > padAngleRad) {
        return 0;
    }

    // --- We are on a pad. Now calculate the realistic pressure profile. ---
    
    // 1. Calculate the angle relative to the pad's leading edge (phi).
    const phi = angleInSegment;

    // 2. Create a sinusoidal pressure profile across the pad.
    // This makes pressure 0 at the start (phi=0) and end (phi=padAngleRad) of the pad.
    const intraPadProfile = Math.sin(phi * Math.PI / padAngleRad);

    // 3. Determine the center of the current pad to find how much load it's taking.
    const padCenterAngle = (segmentIndex * segmentAngleRad) + (padAngleRad / 2);
    
    // 4. Calculate a load factor for this pad. The pad directly opposite the load vector gets the most pressure.
    const loadFactor = Math.max(0, -Math.cos(padCenterAngle - loadAngleRad));
    
    // 5. The final pressure is the combination of the profile within the pad and the load on that pad.
    return intraPadProfile * loadFactor;
  }

  private applyBearingVisuals(bearingGroup: THREE.Group, physics: { values: Float32Array }, range: { min: number; max: number }) {
    const surfaceMesh = bearingGroup.children[0] as THREE.Mesh;
    const geometry = surfaceMesh.geometry;
    const { originalPositions } = geometry.userData;
    const positions = geometry.attributes.position;
    const colors = geometry.attributes.color;
    const color = new THREE.Color();
    const type = this.displayType();
    
    for (let i = 0; i < positions.count; i++) {
        const value = physics.values[i];
        const normalizedValue = (range.max > range.min) ? (value - range.min) / (range.max - range.min) : 0;
        
        let displacementFactor = 0;
        switch(type) {
            case 'pressure': displacementFactor = 0.5; break;
            case 'thickness': displacementFactor = 0.15; break;
            case 'temperature': displacementFactor = 0.25; break;
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

  private animate(): void {
    this.animationFrameId = requestAnimationFrame(() => this.animate());
    this.controls.update();
    
    if (this.isPlaying()) {
        const elapsedTime = this.clock.getElapsedTime();
        const rpm = this.rotationSpeed();
        const visualRotationSpeed = rpm * 0.0001;

        if (this.rotor) {
            const axisSettings = this.settings().rotor.rotationAxis;
            const rotationAxis = new THREE.Vector3(axisSettings.x, axisSettings.y, axisSettings.z).normalize();
            this.rotor.rotateOnAxis(rotationAxis, visualRotationSpeed);
            
            const vibration = (rpm / 4000) * 0.05;
            this.rotor.position.y = this.originalRotorPosition.y + (Math.random() - 0.5) * vibration;
            this.rotor.position.z = this.originalRotorPosition.z + (Math.random() - 0.5) * vibration;
        }
        
        this.updateBearingVisualizations(rpm, elapsedTime);
    }

    this.renderer.autoClear = false;
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    
    // Render axis helper
    const axisViewportSize = 150;
    this.renderer.clearDepth(); 
    this.renderer.setViewport(0, 0, axisViewportSize, axisViewportSize);
    this.axisCamera.position.copy(this.camera.position);
    this.axisCamera.quaternion.copy(this.camera.quaternion);
    this.axisCamera.zoom = this.camera.zoom * 2;
    this.axisCamera.updateProjectionMatrix();
    this.renderer.render(this.axisScene, this.axisCamera);
    this.renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
  }
}
