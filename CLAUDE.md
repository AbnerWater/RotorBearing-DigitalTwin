# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

这是一个基于 Angular 21 的转子-轴承系统三维可视化应用,用于实时模拟和显示转子轴承的油膜压力、厚度和温度分布。该应用使用 Three.js 进行 3D 渲染,D3.js 进行数据可视化,支持自定义转子模型(STL 文件)和多轴承配置。

**技术栈:**
- Angular 21 (Zoneless Change Detection)
- Three.js (3D 图形渲染)
- D3.js (数据可视化图表)
- Tailwind CSS (样式)
- TypeScript 5.8

## 常用命令

### 开发与构建
```bash
# 启动开发服务器 (运行在 http://localhost:3000)
npm run dev

# 生产构建
npm run build

# 预览生产构建
npm run preview
```

### 依赖管理
```bash
# 安装依赖
npm install
```

## 代码架构

### 入口点
- **index.tsx**: 应用的主入口文件,负责引导 Angular 应用并配置 Zoneless 变化检测

### 核心组件
- **src/app.component.ts**: 主应用组件,包含所有核心业务逻辑
  - Three.js 场景初始化和管理
  - 转子和轴承的创建与渲染
  - 物理计算(油膜压力、厚度、温度)
  - 实时数据图表更新
  - 项目配置管理(保存/加载)

### 状态管理
使用 Angular Signals 进行响应式状态管理:
- `settings`: 场景配置(转子和轴承参数)
- `savedSettings`: 最后保存的配置状态
- `settingsForm`: 设置表单的临时状态
- `isDirty`: 计算属性,检测是否有未保存的更改
- `displayType`: 可视化类型('pressure' | 'thickness' | 'temperature')
- `displayStyle`: 显示样式('shaded' | 'shaded-edges' | 'wireframe' | 'transparent')

### 关键数据结构

**SceneSettings**:
```typescript
interface SceneSettings {
    rotor: RotorConfig;      // 转子配置
    bearings: BearingConfig[]; // 轴承配置数组(最多10个)
}
```

**BearingConfig**:
- `position`: 轴承在三维空间中的位置
- `axis`: 轴承的轴向量
- `diameter`: 轴承直径
- `width`: 轴承宽度
- `loadAngle`: 载荷角度
- `padCount`: 瓦块数量(0 表示全圆轴承)
- `padAngle`: 单个瓦块的角度范围

**RotorConfig**:
- `type`: 'default' 或 'stl'
- `fileName`: STL 文件名
- `stlData`: Base64 编码的 STL 文件内容
- `color`: 转子颜色
- `rotationAxis`: 旋转轴向量

### 物理计算

**压力分布计算** (src/app.component.ts:896-946):
- 全圆轴承:使用半 Sommerfeld 近似
- 可倾瓦轴承:使用正弦压力分布配合载荷因子

**轴承可视化更新** (src/app.component.ts:810-857):
- 实时计算每个顶点的压力/厚度/温度值
- 使用 HSL 色彩映射(蓝色=低值,红色=高值)
- 根据数值进行几何变形以增强视觉效果

### 3D 渲染管线

1. **场景初始化** (initThree):
   - 正交相机设置
   - 灯光配置(半球光 + 方向光)
   - 轨道控制器
   - 坐标轴指示器

2. **对象创建**:
   - `createDefaultRotor`: 创建默认圆柱形转子
   - `createRotor`: 支持加载 STL 模型
   - `createBearing`: 创建圆柱形轴承几何体,包含动态颜色顶点

3. **渲染循环** (animate):
   - 转子旋转和振动模拟
   - 轴承可视化更新
   - 主场景和坐标轴场景的双重渲染

### 图表系统

使用 D3.js 创建三个实时图表:
- 压力图表 (pressureChart)
- 厚度图表 (thicknessChart)
- 温度图表 (tempChart)

每个图表最多存储 200 个数据点,超出后滚动显示。

### 项目文件格式

项目保存为 JSON 格式,包含完整的 SceneSettings:
- 转子配置(包括 Base64 编码的 STL 数据)
- 所有轴承的配置参数

## 开发注意事项

### Three.js 类型声明
由于使用全局加载的 Three.js,需要双重声明(src/app.component.ts:3-29):
- `declare var THREE: any` - 用于值访问(如 new THREE.Scene())
- `declare namespace THREE` - 用于类型访问(如 private scene: THREE.Scene)

### D3.js 声明
D3 通过 script 标签加载,声明为 `declare const d3: any`

### 信号效应(Effects)
- 轴承数量变化时自动重新初始化图表数据结构
- 图表可见性变化时管理图表实例的生命周期

### 脏状态检测
使用 JSON 序列化比较来检测配置更改,避免在用户未保存时丢失数据

### STL 文件处理
STL 文件通过 FileReader 读取为 DataURL,提取 Base64 部分存储,渲染时解码为 ArrayBuffer

### 性能优化
- 使用 Zoneless Change Detection 减少变化检测开销
- 几何体和材质在场景重建时正确释放以防止内存泄漏
- 图表更新使用过渡动画(duration: 50ms)保持流畅性

## 文件结构
```
/
├── index.tsx              # Angular 应用入口
├── src/
│   ├── app.component.ts   # 主应用组件(核心逻辑)
│   └── app.component.html # 应用模板(UI 布局)
├── angular.json           # Angular 配置
├── tsconfig.json          # TypeScript 配置
├── package.json           # 依赖和脚本
└── tailwind.config.js     # Tailwind CSS 配置(如果存在)
```
