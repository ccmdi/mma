var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// mma-ext:@deck.gl/core
var require_core = __commonJS({
  "mma-ext:@deck.gl/core"(exports, module) {
    module.exports = globalThis.__mma_require("@deck.gl/core");
  }
});

// mma-ext:@luma.gl/engine
var require_engine = __commonJS({
  "mma-ext:@luma.gl/engine"(exports, module) {
    module.exports = globalThis.__mma_require("@luma.gl/engine");
  }
});

// mma-ext:react
var require_react = __commonJS({
  "mma-ext:react"(exports, module) {
    module.exports = globalThis.__mma_require("react");
  }
});

// mma-ext:react/jsx-runtime
var require_jsx_runtime = __commonJS({
  "mma-ext:react/jsx-runtime"(exports, module) {
    module.exports = globalThis.__mma_require("react/jsx-runtime");
  }
});

// heatmap/node_modules/@deck.gl/aggregation-layers/dist/common/utils/color-utils.js
var defaultColorRange = [
  [255, 255, 178],
  [254, 217, 118],
  [254, 178, 76],
  [253, 141, 60],
  [240, 59, 32],
  [189, 0, 38]
];
function colorRangeToFlatArray(colorRange, normalize = false, ArrayType = Float32Array) {
  let flatArray;
  if (Number.isFinite(colorRange[0])) {
    flatArray = new ArrayType(colorRange);
  } else {
    flatArray = new ArrayType(colorRange.length * 4);
    let index = 0;
    for (let i = 0; i < colorRange.length; i++) {
      const color = colorRange[i];
      flatArray[index++] = color[0];
      flatArray[index++] = color[1];
      flatArray[index++] = color[2];
      flatArray[index++] = Number.isFinite(color[3]) ? color[3] : 255;
    }
  }
  if (normalize) {
    for (let i = 0; i < flatArray.length; i++) {
      flatArray[i] /= 255;
    }
  }
  return flatArray;
}

// heatmap/node_modules/@deck.gl/aggregation-layers/dist/heatmap-layer/heatmap-layer-utils.js
function getBounds(points) {
  const x = points.map((p) => p[0]);
  const y = points.map((p) => p[1]);
  const xMin = Math.min.apply(null, x);
  const xMax = Math.max.apply(null, x);
  const yMin = Math.min.apply(null, y);
  const yMax = Math.max.apply(null, y);
  return [xMin, yMin, xMax, yMax];
}
function boundsContain(currentBounds, targetBounds) {
  if (targetBounds[0] >= currentBounds[0] && targetBounds[2] <= currentBounds[2] && targetBounds[1] >= currentBounds[1] && targetBounds[3] <= currentBounds[3]) {
    return true;
  }
  return false;
}
var scratchArray = new Float32Array(12);
function packVertices(points, dimensions = 2) {
  let index = 0;
  for (const point of points) {
    for (let i = 0; i < dimensions; i++) {
      scratchArray[index++] = point[i] || 0;
    }
  }
  return scratchArray;
}
function scaleToAspectRatio(boundingBox, width, height) {
  const [xMin, yMin, xMax, yMax] = boundingBox;
  const currentWidth = xMax - xMin;
  const currentHeight = yMax - yMin;
  let newWidth = currentWidth;
  let newHeight = currentHeight;
  if (currentWidth / currentHeight < width / height) {
    newWidth = width / height * currentHeight;
  } else {
    newHeight = height / width * currentWidth;
  }
  if (newWidth < width) {
    newWidth = width;
    newHeight = height;
  }
  const xCenter = (xMax + xMin) / 2;
  const yCenter = (yMax + yMin) / 2;
  return [
    xCenter - newWidth / 2,
    yCenter - newHeight / 2,
    xCenter + newWidth / 2,
    yCenter + newHeight / 2
  ];
}
function getTextureCoordinates(point, bounds) {
  const [xMin, yMin, xMax, yMax] = bounds;
  return [(point[0] - xMin) / (xMax - xMin), (point[1] - yMin) / (yMax - yMin)];
}

// heatmap/node_modules/@deck.gl/aggregation-layers/dist/heatmap-layer/heatmap-layer.js
var import_engine2 = __toESM(require_engine(), 1);
var import_core3 = __toESM(require_core(), 1);

// heatmap/node_modules/@deck.gl/aggregation-layers/dist/heatmap-layer/triangle-layer.js
var import_engine = __toESM(require_engine(), 1);
var import_core = __toESM(require_core(), 1);

// heatmap/node_modules/@deck.gl/aggregation-layers/dist/heatmap-layer/triangle-layer-vertex.glsl.js
var triangle_layer_vertex_glsl_default = `#version 300 es
#define SHADER_NAME heatp-map-layer-vertex-shader
uniform sampler2D maxTexture;
in vec3 positions;
in vec2 texCoords;
out vec2 vTexCoords;
out float vIntensityMin;
out float vIntensityMax;
void main(void) {
gl_Position = project_position_to_clipspace(positions, vec3(0.0), vec3(0.0));
vTexCoords = texCoords;
vec4 maxTexture = texture(maxTexture, vec2(0.5));
float maxValue = triangle.aggregationMode < 0.5 ? maxTexture.r : maxTexture.g;
float minValue = maxValue * triangle.threshold;
if (triangle.colorDomain[1] > 0.) {
maxValue = triangle.colorDomain[1];
minValue = triangle.colorDomain[0];
}
vIntensityMax = triangle.intensity / maxValue;
vIntensityMin = triangle.intensity / minValue;
}
`;

// heatmap/node_modules/@deck.gl/aggregation-layers/dist/heatmap-layer/triangle-layer-fragment.glsl.js
var triangle_layer_fragment_glsl_default = `#version 300 es
#define SHADER_NAME triangle-layer-fragment-shader
precision highp float;
uniform sampler2D weightsTexture;
uniform sampler2D colorTexture;
in vec2 vTexCoords;
in float vIntensityMin;
in float vIntensityMax;
out vec4 fragColor;
vec4 getLinearColor(float value) {
float factor = clamp(value * vIntensityMax, 0., 1.);
vec4 color = texture(colorTexture, vec2(factor, 0.5));
color.a *= min(value * vIntensityMin, 1.0);
return color;
}
void main(void) {
vec4 weights = texture(weightsTexture, vTexCoords);
float weight = weights.r;
if (triangle.aggregationMode > 0.5) {
weight /= max(1.0, weights.a);
}
if (weight <= 0.) {
discard;
}
vec4 linearColor = getLinearColor(weight);
linearColor.a *= layer.opacity;
fragColor = linearColor;
}
`;

// heatmap/node_modules/@deck.gl/aggregation-layers/dist/heatmap-layer/triangle-layer-uniforms.js
var uniformBlock = `layout(std140) uniform triangleUniforms {
  float aggregationMode;
  vec2 colorDomain;
  float intensity;
  float threshold;
} triangle;
`;
var triangleUniforms = {
  name: "triangle",
  vs: uniformBlock,
  fs: uniformBlock,
  uniformTypes: {
    aggregationMode: "f32",
    colorDomain: "vec2<f32>",
    intensity: "f32",
    threshold: "f32"
  }
};

// heatmap/node_modules/@deck.gl/aggregation-layers/dist/heatmap-layer/triangle-layer.js
var TriangleLayer = class extends import_core.Layer {
  getShaders() {
    return super.getShaders({ vs: triangle_layer_vertex_glsl_default, fs: triangle_layer_fragment_glsl_default, modules: [import_core.project32, triangleUniforms] });
  }
  initializeState({ device }) {
    this.setState({ model: this._getModel(device) });
  }
  _getModel(device) {
    const { vertexCount, data } = this.props;
    return new import_engine.Model(device, {
      ...this.getShaders(),
      id: this.props.id,
      attributes: data.attributes,
      bufferLayout: [
        { name: "positions", format: "float32x3" },
        { name: "texCoords", format: "float32x2" }
      ],
      topology: "triangle-strip",
      vertexCount
    });
  }
  draw() {
    const { model } = this.state;
    const { aggregationMode, colorDomain, intensity, threshold, colorTexture, maxTexture, weightsTexture } = this.props;
    const triangleProps = {
      aggregationMode,
      colorDomain,
      intensity,
      threshold,
      colorTexture,
      maxTexture,
      weightsTexture
    };
    model.shaderInputs.setProps({ triangle: triangleProps });
    model.draw(this.context.renderPass);
  }
};
TriangleLayer.layerName = "TriangleLayer";
var triangle_layer_default = TriangleLayer;

// heatmap/node_modules/@deck.gl/aggregation-layers/dist/heatmap-layer/aggregation-layer.js
var import_core2 = __toESM(require_core(), 1);

// heatmap/node_modules/@deck.gl/aggregation-layers/dist/common/utils/prop-utils.js
function filterProps(props, filterKeys) {
  const filteredProps = {};
  for (const key in props) {
    if (!filterKeys.includes(key)) {
      filteredProps[key] = props[key];
    }
  }
  return filteredProps;
}

// heatmap/node_modules/@deck.gl/aggregation-layers/dist/heatmap-layer/aggregation-layer.js
var AggregationLayer = class extends import_core2.CompositeLayer {
  initializeAggregationLayer(dimensions) {
    super.initializeState(this.context);
    this.setState({
      // Layer props , when changed doesn't require updating aggregation
      ignoreProps: filterProps(this.constructor._propTypes, dimensions.data.props),
      dimensions
    });
  }
  updateState(opts) {
    super.updateState(opts);
    const { changeFlags } = opts;
    if (changeFlags.extensionsChanged) {
      const shaders = this.getShaders({});
      if (shaders && shaders.defines) {
        shaders.defines.NON_INSTANCED_MODEL = 1;
      }
      this.updateShaders(shaders);
    }
    this._updateAttributes();
  }
  updateAttributes(changedAttributes) {
    this.setState({ changedAttributes });
  }
  getAttributes() {
    return this.getAttributeManager().getAttributes();
  }
  getModuleSettings() {
    const { viewport, mousePosition, device } = this.context;
    const moduleSettings = Object.assign(Object.create(this.props), {
      viewport,
      mousePosition,
      picking: {
        isActive: 0
      },
      // @ts-expect-error TODO - assuming WebGL context
      devicePixelRatio: device.canvasContext.cssToDeviceRatio()
    });
    return moduleSettings;
  }
  updateShaders(shaders) {
  }
  /**
   * Checks if aggregation is dirty
   * @param {Object} updateOpts - object {props, oldProps, changeFlags}
   * @param {Object} params - object {dimension, compareAll}
   * @param {Object} params.dimension - {props, accessors} array of props and/or accessors
   * @param {Boolean} params.compareAll - when `true` it will include non layer props for comparision
   * @returns {Boolean} - returns true if dimensions' prop or accessor is changed
   **/
  isAggregationDirty(updateOpts, params = {}) {
    const { props, oldProps, changeFlags } = updateOpts;
    const { compareAll = false, dimension } = params;
    const { ignoreProps } = this.state;
    const { props: dataProps, accessors = [] } = dimension;
    const { updateTriggersChanged } = changeFlags;
    if (changeFlags.dataChanged) {
      return true;
    }
    if (updateTriggersChanged) {
      if (updateTriggersChanged.all) {
        return true;
      }
      for (const accessor of accessors) {
        if (updateTriggersChanged[accessor]) {
          return true;
        }
      }
    }
    if (compareAll) {
      if (changeFlags.extensionsChanged) {
        return true;
      }
      return (0, import_core2._compareProps)({
        oldProps,
        newProps: props,
        ignoreProps,
        propTypes: this.constructor._propTypes
      });
    }
    for (const name of dataProps) {
      if (props[name] !== oldProps[name]) {
        return true;
      }
    }
    return false;
  }
  /**
   * Checks if an attribute is changed
   * @param {String} name - name of the attribute
   * @returns {Boolean} - `true` if attribute `name` is changed, `false` otherwise,
   *                       If `name` is not passed or `undefiend`, `true` if any attribute is changed, `false` otherwise
   **/
  isAttributeChanged(name) {
    const { changedAttributes } = this.state;
    if (!name) {
      return !isObjectEmpty(changedAttributes);
    }
    return changedAttributes && changedAttributes[name] !== void 0;
  }
  // Private
  // override Composite layer private method to create AttributeManager instance
  _getAttributeManager() {
    return new import_core2.AttributeManager(this.context.device, {
      id: this.props.id,
      stats: this.context.stats
    });
  }
};
AggregationLayer.layerName = "AggregationLayer";
var aggregation_layer_default = AggregationLayer;
function isObjectEmpty(obj) {
  let isEmpty = true;
  for (const key in obj) {
    isEmpty = false;
    break;
  }
  return isEmpty;
}

// heatmap/node_modules/@deck.gl/aggregation-layers/dist/heatmap-layer/weights-vs.glsl.js
var weights_vs_glsl_default = `#version 300 es
in vec3 positions;
in vec3 positions64Low;
in float weights;
out vec4 weightsTexture;
void main()
{
weightsTexture = vec4(weights * weight.weightsScale, 0., 0., 1.);
float radiusTexels = project_pixel_size(weight.radiusPixels) * weight.textureWidth / (weight.commonBounds.z - weight.commonBounds.x);
gl_PointSize = radiusTexels * 2.;
vec3 commonPosition = project_position(positions, positions64Low);
gl_Position.xy = (commonPosition.xy - weight.commonBounds.xy) / (weight.commonBounds.zw - weight.commonBounds.xy) ;
gl_Position.xy = (gl_Position.xy * 2.) - (1.);
gl_Position.w = 1.0;
}
`;

// heatmap/node_modules/@deck.gl/aggregation-layers/dist/heatmap-layer/weights-fs.glsl.js
var weights_fs_glsl_default = `#version 300 es
in vec4 weightsTexture;
out vec4 fragColor;
float gaussianKDE(float u){
return pow(2.71828, -u*u/0.05555)/(1.77245385*0.166666);
}
void main()
{
float dist = length(gl_PointCoord - vec2(0.5, 0.5));
if (dist > 0.5) {
discard;
}
fragColor = weightsTexture * gaussianKDE(2. * dist);
DECKGL_FILTER_COLOR(fragColor, geometry);
}
`;

// heatmap/node_modules/@deck.gl/aggregation-layers/dist/heatmap-layer/max-vs.glsl.js
var max_vs_glsl_default = `#version 300 es
uniform sampler2D inTexture;
out vec4 outTexture;
void main()
{
int yIndex = gl_VertexID / int(maxWeight.textureSize);
int xIndex = gl_VertexID - (yIndex * int(maxWeight.textureSize));
vec2 uv = (0.5 + vec2(float(xIndex), float(yIndex))) / maxWeight.textureSize;
outTexture = texture(inTexture, uv);
gl_Position = vec4(0.0, 0.0, 0.0, 1.0);
gl_PointSize = 1.0;
}
`;

// heatmap/node_modules/@deck.gl/aggregation-layers/dist/heatmap-layer/max-fs.glsl.js
var max_fs_glsl_default = `#version 300 es
in vec4 outTexture;
out vec4 fragColor;
void main() {
fragColor = outTexture;
fragColor.g = outTexture.r / max(1.0, outTexture.a);
}
`;

// heatmap/node_modules/@deck.gl/aggregation-layers/dist/heatmap-layer/heatmap-layer-uniforms.js
var uniformBlock2 = `layout(std140) uniform weightUniforms {
  vec4 commonBounds;
  float radiusPixels;
  float textureWidth;
  float weightsScale;
} weight;
`;
var weightUniforms = {
  name: "weight",
  vs: uniformBlock2,
  uniformTypes: {
    commonBounds: "vec4<f32>",
    radiusPixels: "f32",
    textureWidth: "f32",
    weightsScale: "f32"
  }
};
var maxWeightUniforms = {
  name: "maxWeight",
  vs: `layout(std140) uniform maxWeightUniforms {
  float textureSize;
} maxWeight;
`,
  uniformTypes: {
    textureSize: "f32"
  }
};

// heatmap/node_modules/@deck.gl/aggregation-layers/dist/heatmap-layer/heatmap-layer.js
var RESOLUTION = 2;
var TEXTURE_PROPS = {
  format: "rgba8unorm",
  dimension: "2d",
  width: 1,
  height: 1,
  sampler: {
    minFilter: "linear",
    magFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge"
  }
};
var DEFAULT_COLOR_DOMAIN = [0, 0];
var AGGREGATION_MODE = {
  SUM: 0,
  MEAN: 1
};
var defaultProps = {
  getPosition: { type: "accessor", value: (x) => x.position },
  getWeight: { type: "accessor", value: 1 },
  intensity: { type: "number", min: 0, value: 1 },
  radiusPixels: { type: "number", min: 1, max: 100, value: 50 },
  colorRange: defaultColorRange,
  threshold: { type: "number", min: 0, max: 1, value: 0.05 },
  colorDomain: { type: "array", value: null, optional: true },
  // 'SUM' or 'MEAN'
  aggregation: "SUM",
  weightsTextureSize: { type: "number", min: 128, max: 2048, value: 2048 },
  debounceTimeout: { type: "number", min: 0, max: 1e3, value: 500 }
};
var FLOAT_TARGET_FEATURES = [
  "float32-renderable-webgl",
  // ability to render to float texture
  "texture-blend-float-webgl"
  // ability to blend when rendering to float texture
];
var DIMENSIONS = {
  data: {
    props: ["radiusPixels"]
  }
};
var HeatmapLayer = class extends aggregation_layer_default {
  getShaders(shaders) {
    let modules = [import_core3.project32];
    if (shaders.modules) {
      modules = [...modules, ...shaders.modules];
    }
    return super.getShaders({ ...shaders, modules });
  }
  initializeState() {
    super.initializeAggregationLayer(DIMENSIONS);
    this.setState({ colorDomain: DEFAULT_COLOR_DOMAIN });
    this._setupTextureParams();
    this._setupAttributes();
    this._setupResources();
  }
  shouldUpdateState({ changeFlags }) {
    return changeFlags.somethingChanged;
  }
  /* eslint-disable max-statements,complexity */
  updateState(opts) {
    super.updateState(opts);
    this._updateHeatmapState(opts);
  }
  _updateHeatmapState(opts) {
    const { props, oldProps } = opts;
    const changeFlags = this._getChangeFlags(opts);
    if (changeFlags.dataChanged || changeFlags.viewportChanged) {
      changeFlags.boundsChanged = this._updateBounds(changeFlags.dataChanged);
      this._updateTextureRenderingBounds();
    }
    if (changeFlags.dataChanged || changeFlags.boundsChanged) {
      clearTimeout(this.state.updateTimer);
      this.setState({ isWeightMapDirty: true });
      if (changeFlags.dataChanged) {
        const weightsTransformShaders = this.getShaders({ vs: weights_vs_glsl_default, fs: weights_fs_glsl_default });
        this._createWeightsTransform(weightsTransformShaders);
      }
    } else if (changeFlags.viewportZoomChanged) {
      this._debouncedUpdateWeightmap();
    }
    if (props.colorRange !== oldProps.colorRange) {
      this._updateColorTexture(opts);
    }
    if (this.state.isWeightMapDirty) {
      this._updateWeightmap();
    }
    this.setState({ zoom: opts.context.viewport.zoom });
  }
  renderLayers() {
    const { weightsTexture, triPositionBuffer, triTexCoordBuffer, maxWeightsTexture, colorTexture, colorDomain } = this.state;
    const { updateTriggers, intensity, threshold, aggregation } = this.props;
    const TriangleLayerClass = this.getSubLayerClass("triangle", triangle_layer_default);
    return new TriangleLayerClass(this.getSubLayerProps({
      id: "triangle-layer",
      updateTriggers
    }), {
      // position buffer is filled with world coordinates generated from viewport.unproject
      // i.e. LNGLAT if geospatial, CARTESIAN otherwise
      coordinateSystem: "default",
      data: {
        attributes: {
          positions: triPositionBuffer,
          texCoords: triTexCoordBuffer
        }
      },
      vertexCount: 4,
      maxTexture: maxWeightsTexture,
      colorTexture,
      aggregationMode: AGGREGATION_MODE[aggregation] || 0,
      weightsTexture,
      intensity,
      threshold,
      colorDomain
    });
  }
  finalizeState(context) {
    super.finalizeState(context);
    const { weightsTransform, weightsTexture, maxWeightTransform, maxWeightsTexture, triPositionBuffer, triTexCoordBuffer, colorTexture, updateTimer } = this.state;
    weightsTransform?.destroy();
    weightsTexture?.destroy();
    maxWeightTransform?.destroy();
    maxWeightsTexture?.destroy();
    triPositionBuffer?.destroy();
    triTexCoordBuffer?.destroy();
    colorTexture?.destroy();
    if (updateTimer) {
      clearTimeout(updateTimer);
    }
  }
  // PRIVATE
  // override Composite layer private method to create AttributeManager instance
  _getAttributeManager() {
    return new import_core3.AttributeManager(this.context.device, {
      id: this.props.id,
      stats: this.context.stats
    });
  }
  _getChangeFlags(opts) {
    const changeFlags = {};
    const { dimensions } = this.state;
    changeFlags.dataChanged = this.isAttributeChanged() && "attribute changed" || // if any attribute is changed
    this.isAggregationDirty(opts, {
      compareAll: true,
      dimension: dimensions.data
    }) && "aggregation is dirty";
    changeFlags.viewportChanged = opts.changeFlags.viewportChanged;
    const { zoom } = this.state;
    if (!opts.context.viewport || opts.context.viewport.zoom !== zoom) {
      changeFlags.viewportZoomChanged = true;
    }
    return changeFlags;
  }
  _createTextures() {
    const { textureSize, format } = this.state;
    this.setState({
      weightsTexture: this.context.device.createTexture({
        ...TEXTURE_PROPS,
        width: textureSize,
        height: textureSize,
        format
      }),
      maxWeightsTexture: this.context.device.createTexture({
        ...TEXTURE_PROPS,
        width: 1,
        height: 1,
        format
      })
    });
  }
  _setupAttributes() {
    const attributeManager = this.getAttributeManager();
    attributeManager.add({
      positions: { size: 3, type: "float64", accessor: "getPosition" },
      weights: { size: 1, accessor: "getWeight" }
    });
    this.setState({ positionAttributeName: "positions" });
  }
  _setupTextureParams() {
    const { device } = this.context;
    const { weightsTextureSize } = this.props;
    const textureSize = Math.min(weightsTextureSize, device.limits.maxTextureDimension2D);
    const floatTargetSupport = FLOAT_TARGET_FEATURES.every((feature) => device.features.has(feature));
    const format = floatTargetSupport ? "rgba32float" : "rgba8unorm";
    const weightsScale = floatTargetSupport ? 1 : 1 / 255;
    this.setState({ textureSize, format, weightsScale });
    if (!floatTargetSupport) {
      import_core3.log.warn(`HeatmapLayer: ${this.id} rendering to float texture not supported, falling back to low precision format`)();
    }
  }
  _createWeightsTransform(shaders) {
    let { weightsTransform } = this.state;
    const { weightsTexture } = this.state;
    const attributeManager = this.getAttributeManager();
    weightsTransform?.destroy();
    weightsTransform = new import_engine2.TextureTransform(this.context.device, {
      id: `${this.id}-weights-transform`,
      ...shaders,
      bufferLayout: attributeManager.getBufferLayouts(),
      vertexCount: 1,
      targetTexture: weightsTexture,
      parameters: {
        depthWriteEnabled: false,
        blend: true,
        blendColorOperation: "add",
        blendColorSrcFactor: "one",
        blendColorDstFactor: "one",
        blendAlphaSrcFactor: "one",
        blendAlphaDstFactor: "one"
      },
      topology: "point-list",
      modules: [...shaders.modules, weightUniforms]
    });
    this.setState({ weightsTransform });
  }
  _setupResources() {
    this._createTextures();
    const { device } = this.context;
    const { textureSize, weightsTexture, maxWeightsTexture } = this.state;
    const weightsTransformShaders = this.getShaders({
      vs: weights_vs_glsl_default,
      fs: weights_fs_glsl_default
    });
    this._createWeightsTransform(weightsTransformShaders);
    const maxWeightsTransformShaders = this.getShaders({
      vs: max_vs_glsl_default,
      fs: max_fs_glsl_default,
      modules: [maxWeightUniforms]
    });
    const maxWeightTransform = new import_engine2.TextureTransform(device, {
      id: `${this.id}-max-weights-transform`,
      targetTexture: maxWeightsTexture,
      ...maxWeightsTransformShaders,
      vertexCount: textureSize * textureSize,
      topology: "point-list",
      parameters: {
        depthWriteEnabled: false,
        blend: true,
        blendColorOperation: "max",
        blendAlphaOperation: "max",
        blendColorSrcFactor: "one",
        blendColorDstFactor: "one",
        blendAlphaSrcFactor: "one",
        blendAlphaDstFactor: "one"
      }
    });
    const maxWeightProps = { inTexture: weightsTexture, textureSize };
    maxWeightTransform.model.shaderInputs.setProps({
      maxWeight: maxWeightProps
    });
    this.setState({
      weightsTexture,
      maxWeightsTexture,
      maxWeightTransform,
      zoom: null,
      triPositionBuffer: device.createBuffer({ byteLength: 48 }),
      triTexCoordBuffer: device.createBuffer({ byteLength: 48 })
    });
  }
  // overwrite super class method to update transform model
  updateShaders(shaderOptions) {
    this._createWeightsTransform({
      vs: weights_vs_glsl_default,
      fs: weights_fs_glsl_default,
      ...shaderOptions
    });
  }
  _updateMaxWeightValue() {
    const { maxWeightTransform } = this.state;
    maxWeightTransform.run({
      parameters: { viewport: [0, 0, 1, 1] },
      clearColor: [0, 0, 0, 0]
    });
  }
  // Computes world bounds area that needs to be processed for generate heatmap
  _updateBounds(forceUpdate = false) {
    const { viewport } = this.context;
    const viewportCorners = [
      viewport.unproject([0, 0]),
      viewport.unproject([viewport.width, 0]),
      viewport.unproject([0, viewport.height]),
      viewport.unproject([viewport.width, viewport.height])
    ].map((p) => p.map(Math.fround));
    const visibleWorldBounds = getBounds(viewportCorners);
    const newState = { visibleWorldBounds, viewportCorners };
    let boundsChanged = false;
    if (forceUpdate || !this.state.worldBounds || !boundsContain(this.state.worldBounds, visibleWorldBounds)) {
      const scaledCommonBounds = this._worldToCommonBounds(visibleWorldBounds);
      const worldBounds = this._commonToWorldBounds(scaledCommonBounds);
      if (this.props.coordinateSystem === "lnglat") {
        worldBounds[1] = Math.max(worldBounds[1], -85.051129);
        worldBounds[3] = Math.min(worldBounds[3], 85.051129);
        worldBounds[0] = Math.max(worldBounds[0], -360);
        worldBounds[2] = Math.min(worldBounds[2], 360);
      }
      const normalizedCommonBounds = this._worldToCommonBounds(worldBounds);
      newState.worldBounds = worldBounds;
      newState.normalizedCommonBounds = normalizedCommonBounds;
      boundsChanged = true;
    }
    this.setState(newState);
    return boundsChanged;
  }
  _updateTextureRenderingBounds() {
    const { triPositionBuffer, triTexCoordBuffer, normalizedCommonBounds, viewportCorners } = this.state;
    const { viewport } = this.context;
    triPositionBuffer.write(packVertices(viewportCorners, 3));
    const textureBounds = viewportCorners.map((p) => getTextureCoordinates(viewport.projectPosition(p), normalizedCommonBounds));
    triTexCoordBuffer.write(packVertices(textureBounds, 2));
  }
  _updateColorTexture(opts) {
    const { colorRange } = opts.props;
    let { colorTexture } = this.state;
    const colors = colorRangeToFlatArray(colorRange, false, Uint8Array);
    colorTexture?.destroy();
    colorTexture = this.context.device.createTexture({
      ...TEXTURE_PROPS,
      data: colors,
      width: colorRange.length,
      height: 1
    });
    this.setState({ colorTexture });
  }
  _updateWeightmap() {
    const { radiusPixels, colorDomain, aggregation } = this.props;
    const { worldBounds, textureSize, weightsScale, weightsTexture } = this.state;
    const weightsTransform = this.state.weightsTransform;
    this.state.isWeightMapDirty = false;
    const commonBounds = this._worldToCommonBounds(worldBounds, {
      useLayerCoordinateSystem: true
    });
    if (colorDomain && aggregation === "SUM") {
      const { viewport: viewport2 } = this.context;
      const metersPerPixel = viewport2.distanceScales.metersPerUnit[2] * (commonBounds[2] - commonBounds[0]) / textureSize;
      this.state.colorDomain = [
        colorDomain[0] * metersPerPixel * weightsScale,
        colorDomain[1] * metersPerPixel * weightsScale
      ];
    } else {
      this.state.colorDomain = colorDomain || DEFAULT_COLOR_DOMAIN;
    }
    const attributeManager = this.getAttributeManager();
    const attributes = attributeManager.getAttributes();
    const moduleSettings = this.getModuleSettings();
    this._setModelAttributes(weightsTransform.model, attributes);
    weightsTransform.model.setVertexCount(this.getNumInstances());
    const weightProps = {
      radiusPixels,
      commonBounds,
      textureWidth: textureSize,
      weightsScale,
      weightsTexture
    };
    const { viewport, devicePixelRatio, coordinateSystem, coordinateOrigin } = moduleSettings;
    const { modelMatrix } = this.props;
    weightsTransform.model.shaderInputs.setProps({
      project: { viewport, devicePixelRatio, modelMatrix, coordinateSystem, coordinateOrigin },
      weight: weightProps
    });
    weightsTransform.run({
      parameters: { viewport: [0, 0, textureSize, textureSize] },
      clearColor: [0, 0, 0, 0]
    });
    this._updateMaxWeightValue();
  }
  _debouncedUpdateWeightmap(fromTimer = false) {
    let { updateTimer } = this.state;
    const { debounceTimeout } = this.props;
    if (fromTimer) {
      updateTimer = null;
      this._updateBounds(true);
      this._updateTextureRenderingBounds();
      this.setState({ isWeightMapDirty: true });
    } else {
      this.setState({ isWeightMapDirty: false });
      clearTimeout(updateTimer);
      updateTimer = setTimeout(this._debouncedUpdateWeightmap.bind(this, true), debounceTimeout);
    }
    this.setState({ updateTimer });
  }
  // input: worldBounds: [minLong, minLat, maxLong, maxLat]
  // input: opts.useLayerCoordinateSystem : layers coordiante system is used
  // optput: commonBounds: [minX, minY, maxX, maxY] scaled to fit the current texture
  _worldToCommonBounds(worldBounds, opts = {}) {
    const { useLayerCoordinateSystem = false } = opts;
    const [minLong, minLat, maxLong, maxLat] = worldBounds;
    const { viewport } = this.context;
    const { textureSize } = this.state;
    const { coordinateSystem } = this.props;
    const offsetMode = useLayerCoordinateSystem && (coordinateSystem === "lnglat-offsets" || coordinateSystem === "meter-offsets");
    const offsetOriginCommon = offsetMode ? viewport.projectPosition(this.props.coordinateOrigin) : [0, 0];
    const size = textureSize * RESOLUTION / viewport.scale;
    let bottomLeftCommon;
    let topRightCommon;
    if (useLayerCoordinateSystem && !offsetMode) {
      bottomLeftCommon = this.projectPosition([minLong, minLat, 0]);
      topRightCommon = this.projectPosition([maxLong, maxLat, 0]);
    } else {
      bottomLeftCommon = viewport.projectPosition([minLong, minLat, 0]);
      topRightCommon = viewport.projectPosition([maxLong, maxLat, 0]);
    }
    return scaleToAspectRatio([
      bottomLeftCommon[0] - offsetOriginCommon[0],
      bottomLeftCommon[1] - offsetOriginCommon[1],
      topRightCommon[0] - offsetOriginCommon[0],
      topRightCommon[1] - offsetOriginCommon[1]
    ], size, size);
  }
  // input commonBounds: [xMin, yMin, xMax, yMax]
  // output worldBounds: [minLong, minLat, maxLong, maxLat]
  _commonToWorldBounds(commonBounds) {
    const [xMin, yMin, xMax, yMax] = commonBounds;
    const { viewport } = this.context;
    const bottomLeftWorld = viewport.unprojectPosition([xMin, yMin]);
    const topRightWorld = viewport.unprojectPosition([xMax, yMax]);
    return bottomLeftWorld.slice(0, 2).concat(topRightWorld.slice(0, 2));
  }
};
HeatmapLayer.layerName = "HeatmapLayer";
HeatmapLayer.defaultProps = defaultProps;
var heatmap_layer_default = HeatmapLayer;

// heatmap/src/gradients.ts
var MIN_STOPS = 2;
var clamp01 = (n) => Math.min(1, Math.max(0, n));
function evenStops(colors) {
  if (colors.length === 1) return [{ color: colors[0], pos: 0 }];
  return colors.map((color, i) => ({ color, pos: i / (colors.length - 1) }));
}
var BUILTIN_COLORS = [
  // deck.gl's built-in default colorRange (6-step ColorBrewer YlOrRd) — the original look.
  {
    id: "classic",
    name: "Classic",
    colors: [
      [255, 255, 178],
      [254, 217, 118],
      [254, 178, 76],
      [253, 141, 60],
      [240, 59, 32],
      [189, 0, 38]
    ]
  },
  {
    id: "viridis",
    name: "Viridis",
    colors: [
      [68, 1, 84],
      [59, 82, 139],
      [33, 145, 140],
      [94, 201, 98],
      [253, 231, 37]
    ]
  },
  {
    id: "inferno",
    name: "Inferno",
    colors: [
      [0, 0, 4],
      [87, 16, 110],
      [188, 55, 84],
      [249, 142, 9],
      [252, 255, 164]
    ]
  },
  {
    id: "plasma",
    name: "Plasma",
    colors: [
      [13, 8, 135],
      [126, 3, 168],
      [204, 71, 120],
      [248, 149, 64],
      [240, 249, 33]
    ]
  },
  {
    id: "magma",
    name: "Magma",
    colors: [
      [0, 0, 4],
      [81, 18, 124],
      [183, 55, 121],
      [252, 137, 97],
      [252, 253, 191]
    ]
  },
  {
    id: "cividis",
    name: "Cividis",
    colors: [
      [0, 32, 76],
      [87, 92, 109],
      [170, 156, 116],
      [255, 234, 70]
    ]
  },
  {
    id: "heat",
    name: "Heat",
    colors: [
      [0, 0, 255],
      [0, 255, 255],
      [0, 255, 0],
      [255, 255, 0],
      [255, 0, 0]
    ]
  },
  {
    id: "blue-red",
    name: "Blue-Red",
    colors: [
      [66, 133, 244],
      [234, 67, 53]
    ]
  },
  {
    id: "green-yellow-red",
    name: "Green-Yellow-Red",
    colors: [
      [52, 168, 83],
      [251, 188, 4],
      [234, 67, 53]
    ]
  },
  {
    id: "purple-orange",
    name: "Purple-Orange",
    colors: [
      [136, 84, 208],
      [255, 152, 0]
    ]
  },
  {
    id: "blues",
    name: "Blues",
    colors: [
      [222, 235, 247],
      [158, 202, 225],
      [49, 130, 189]
    ]
  },
  {
    id: "reds",
    name: "Reds",
    colors: [
      [254, 224, 210],
      [252, 146, 114],
      [222, 45, 38]
    ]
  },
  {
    id: "greens",
    name: "Greens",
    colors: [
      [229, 245, 224],
      [161, 217, 155],
      [49, 163, 84]
    ]
  },
  {
    id: "purples",
    name: "Purples",
    colors: [
      [239, 237, 245],
      [188, 189, 220],
      [117, 107, 177]
    ]
  }
];
var BUILTIN_GRADIENTS = BUILTIN_COLORS.map((g) => ({
  id: g.id,
  name: g.name,
  stops: evenStops(g.colors)
}));
var DEFAULT_GRADIENT_ID = BUILTIN_GRADIENTS[0].id;
var BUILTIN_IDS = new Set(BUILTIN_GRADIENTS.map((g) => g.id));
function isBuiltinGradient(id) {
  return BUILTIN_IDS.has(id);
}
function gradientIdFromLegacyIndex(index) {
  if (typeof index !== "number") return DEFAULT_GRADIENT_ID;
  return BUILTIN_GRADIENTS[index]?.id ?? DEFAULT_GRADIENT_ID;
}
function normalizeStops(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  if (Array.isArray(raw[0])) return evenStops(raw);
  return raw.filter((s) => s && Array.isArray(s.color)).map((s) => ({
    color: [...s.color],
    pos: clamp01(Number(s.pos) || 0)
  })).sort((a, b) => a.pos - b.pos);
}
function normalizeGradient(g) {
  return { ...g, stops: normalizeStops(g.stops) };
}
function resolveGradient(id, customs) {
  return BUILTIN_GRADIENTS.find((g) => g.id === id) ?? customs.find((g) => g.id === id) ?? BUILTIN_GRADIENTS[0];
}
function newCustomGradient(from) {
  return {
    id: crypto.randomUUID(),
    name: `${from.name} copy`,
    stops: from.stops.map((s) => ({ color: [...s.color], pos: s.pos }))
  };
}
function colorAt(stops, t) {
  if (stops.length === 0) return [0, 0, 0];
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (t <= first.pos) return first.color;
  if (t >= last.pos) return last.color;
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (t > b.pos) continue;
    const span = b.pos - a.pos;
    const f = span <= 0 ? 0 : (t - a.pos) / span;
    return [
      Math.round(a.color[0] + (b.color[0] - a.color[0]) * f),
      Math.round(a.color[1] + (b.color[1] - a.color[1]) * f),
      Math.round(a.color[2] + (b.color[2] - a.color[2]) * f)
    ];
  }
  return last.color;
}
function sampleColorRange(stops, n = 32) {
  if (stops.length === 0)
    return sampleColorRange(BUILTIN_GRADIENTS[0].stops, n);
  if (n === 1) return [colorAt(stops, 0)];
  return Array.from({ length: n }, (_, i) => colorAt(stops, i / (n - 1)));
}
function gradientCss(stops) {
  if (stops.length === 0) return "transparent";
  const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
  if (stops.length === 1) return rgb(stops[0].color);
  const parts = stops.map(
    (s) => `${rgb(s.color)} ${+(s.pos * 100).toFixed(2)}%`
  );
  return `linear-gradient(to right, ${parts.join(", ")})`;
}
function moveStop(stops, index, pos) {
  const target = stops[index];
  if (!target) return { stops, index };
  const moved = {
    color: [...target.color],
    pos: clamp01(pos)
  };
  const next = stops.map((s, i) => i === index ? moved : s).sort((a, b) => a.pos - b.pos);
  return { stops: next, index: next.indexOf(moved) };
}
function addStopAt(stops, pos) {
  const p = clamp01(pos);
  const added = { color: colorAt(stops, p), pos: p };
  const next = [...stops, added].sort((a, b) => a.pos - b.pos);
  return { stops: next, index: next.indexOf(added) };
}
function removeStop(stops, index) {
  if (stops.length <= MIN_STOPS) return stops;
  return stops.filter((_, i) => i !== index);
}
function setStopColor(stops, index, color) {
  return stops.map((s, i) => i === index ? { ...s, color } : s);
}
function reverseStops(stops) {
  return stops.map((s) => ({ ...s, pos: 1 - s.pos })).reverse();
}
function rgbToHex(c) {
  return `#${c.map(
    (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")
  ).join("")}`;
}
function hexToRgb(hex) {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [
    parseInt(full.slice(0, 2), 16) || 0,
    parseInt(full.slice(2, 4), 16) || 0,
    parseInt(full.slice(4, 6), 16) || 0
  ];
}

// heatmap/src/heatmap.ts
var { storage, getMapState, resolveIds, selectorForPick, getScenePositions, getMapHost, on } = MMA;
var LAYER_DEFAULTS = {
  visible: true,
  intensity: 1,
  radiusPixels: 30,
  opacity: 0.6,
  threshold: 0.05,
  gradientId: DEFAULT_GRADIENT_ID
};
var store = storage("heatmap");
function defaultSource() {
  return getMapState().selectedLocationIds.size > 0 ? { pick: "selection" } : { pick: "all" };
}
function newLayer() {
  return {
    id: crypto.randomUUID(),
    source: defaultSource(),
    ...LAYER_DEFAULTS
  };
}
function migrateSource(source) {
  if (!source || typeof source !== "object" || !("kind" in source))
    return void 0;
  const { kind, id } = source;
  if (kind === "selected") return { pick: "selection" };
  if (kind === "saved" && id) return { pick: "saved", id };
  return { pick: "all" };
}
function migrateLayer(stored) {
  const { gradientIndex, ...rest } = stored;
  const layer = { ...newLayer(), ...rest };
  if (rest.gradientId === void 0)
    layer.gradientId = gradientIdFromLegacyIndex(gradientIndex);
  const source = migrateSource(rest.source);
  if (source) layer.source = source;
  return layer;
}
function loadLayers() {
  const stored = store.get("layers");
  if (stored?.length) return stored.map(migrateLayer);
  const legacy = store.get("settings");
  return [migrateLayer(legacy ?? {})];
}
function loadGradients() {
  return (store.get("gradients") ?? []).map(
    normalizeGradient
  );
}
var overlay = null;
var layers = loadLayers();
var customGradients = loadGradients();
var onSettingsChange = null;
function getLayers() {
  return layers;
}
function getCustomGradients() {
  return customGradients;
}
function setOnSettingsChange(cb) {
  onSettingsChange = cb;
}
function commit() {
  store.set("layers", layers);
  rebuild();
  onSettingsChange?.();
}
function updateLayer(id, patch) {
  layers = layers.map((l) => l.id === id ? { ...l, ...patch } : l);
  commit();
}
function addLayer() {
  layers = [...layers, newLayer()];
  commit();
}
function removeLayer(id) {
  layers = layers.filter((l) => l.id !== id);
  commit();
}
function resetLayers() {
  layers = [newLayer()];
  commit();
}
function commitGradients() {
  store.set("gradients", customGradients);
  commit();
}
function addCustomGradient(layerId, from) {
  const gradient = newCustomGradient(from);
  customGradients = [...customGradients, gradient];
  layers = layers.map(
    (l) => l.id === layerId ? { ...l, gradientId: gradient.id } : l
  );
  commitGradients();
  return gradient;
}
function updateCustomGradient(id, patch) {
  if (isBuiltinGradient(id)) return;
  customGradients = customGradients.map(
    (g) => g.id === id ? { ...g, ...patch } : g
  );
  commitGradients();
}
function removeCustomGradient(id) {
  customGradients = customGradients.filter((g) => g.id !== id);
  layers = layers.map(
    (l) => l.gradientId === id ? { ...l, gradientId: DEFAULT_GRADIENT_ID } : l
  );
  commitGradients();
}
async function sourceData(source) {
  const ids = source.pick === "all" ? null : new Set(await resolveIds(selectorForPick(source)));
  const scene = getScenePositions();
  const out = [];
  for (let i = 0; i < scene.ids.length; i++) {
    if (ids && !ids.has(scene.ids[i])) continue;
    out.push({ lng: scene.positions[i * 2], lat: scene.positions[i * 2 + 1] });
  }
  return out;
}
var rebuildToken = 0;
async function rebuild() {
  if (!overlay) return;
  const token = ++rebuildToken;
  const visible = layers.filter((l) => l.visible);
  const datas = await Promise.all(visible.map((l) => sourceData(l.source)));
  if (token !== rebuildToken || !overlay) return;
  const deckLayers = visible.map(
    (l, i) => new heatmap_layer_default({
      id: `mma-heatmap-${l.id}`,
      data: datas[i],
      getPosition: (d) => [d.lng, d.lat],
      getWeight: 1,
      radiusPixels: l.radiusPixels,
      intensity: l.intensity,
      threshold: l.threshold,
      opacity: l.opacity,
      colorRange: sampleColorRange(
        resolveGradient(l.gradientId, customGradients).stops
      ),
      debounceTimeout: 100
    })
  );
  overlay.setProps({ layers: deckLayers });
}
async function init() {
  const host = getMapHost();
  if (!host) throw new Error("No map instance");
  overlay = host.createDeckOverlay();
  void rebuild();
  let rebuildTimer;
  const onChange = () => {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => void rebuild(), 100);
    onSettingsChange?.();
  };
  const unsub = on("scene:changed", onChange);
  return () => {
    unsub();
    clearTimeout(rebuildTimer);
    if (overlay) {
      overlay.finalize();
      overlay = null;
    }
    layers = loadLayers();
    customGradients = loadGradients();
    onSettingsChange = null;
  };
}

// heatmap/src/HeatmapSidebar.tsx
var import_react = __toESM(require_react());
var import_jsx_runtime = __toESM(require_jsx_runtime());
var { useMapState, selectorForPick: selectorForPick2, ui: { SelectorPicker } } = MMA;
var CSS = `
.heatmap-sidebar { overflow: auto; }
.heatmap-sidebar__header {
  display: flex; align-items: center; gap: 8px;
  padding: 8px; border-bottom: 1px solid var(--color-divider, #333);
}
.heatmap-sidebar__title { margin: 0; font-size: 14px; font-weight: 600; }
.heatmap-sidebar__body {
  padding: 12px; display: flex; flex-direction: column; gap: 12px;
}
.heatmap-sidebar__section {
  border-bottom: 1px solid var(--color-divider, #333);
  padding-bottom: 10px;
}
.heatmap-sidebar__section:last-child { border-bottom: none; padding-bottom: 0; }
.heatmap-sidebar__section-title {
  font-size: 11px; font-weight: 600; text-transform: uppercase;
  color: var(--text-secondary, #999); margin: 0 0 6px;
}
.heatmap-sidebar__layer-header {
  display: flex; align-items: center; gap: 8px; padding: 2px 0 6px;
}
.heatmap-sidebar__layer-title { flex: 1; font-size: 13px; font-weight: 600; }
.heatmap-sidebar__control {
  display: flex; align-items: center; gap: 8px; padding: 2px 0;
}
.heatmap-sidebar__control label {
  flex: 1; font-size: 13px;
}
.heatmap-sidebar__control input[type="range"] {
  width: 100px;
}
.heatmap-sidebar__control .heatmap-sidebar__value {
  min-width: 36px; text-align: right; font-size: 12px;
  color: var(--text-secondary, #999); font-variant-numeric: tabular-nums;
}
.heatmap-sidebar__reset {
  font-size: 12px; color: var(--text-secondary, #999);
  background: none; border: none; cursor: pointer; padding: 0;
  text-decoration: underline;
}
.heatmap-sidebar__reset:hover { color: var(--text-primary, #fff); }
.heatmap-sidebar__add {
  width: 100%; padding: 6px; font-size: 13px; cursor: pointer;
  background: none; border: 1px dashed var(--color-divider, #444);
  border-radius: 4px; color: var(--text-secondary, #999);
}
.heatmap-sidebar__add:hover {
  color: var(--text-primary, #fff);
  border-color: var(--text-secondary, #999);
}
.heatmap-sidebar .selector-picker { padding: 2px 0 6px; font-size: 13px; }
.heatmap-sidebar__gradients {
  display: grid; grid-template-columns: 1fr 1fr; gap: 4px;
}
.heatmap-sidebar__gradient {
  background: none; border: 2px solid transparent; border-radius: 4px;
  padding: 2px; cursor: pointer; width: 100%;
}
.heatmap-sidebar__gradient--active { border-color: var(--accent-color, #4a9eff); }
.heatmap-sidebar__gradient-bar { height: 14px; border-radius: 2px; }
.heatmap-sidebar__gradient-new {
  border: 1px dashed var(--color-divider, #444); border-radius: 4px;
  background: none; color: var(--text-secondary, #999); cursor: pointer;
  font-size: 12px; padding: 3px 2px;
}
.heatmap-sidebar__gradient-new:hover {
  color: var(--text-primary, #fff); border-color: var(--text-secondary, #999);
}
.heatmap-sidebar__editor {
  border: 1px solid var(--color-divider, #333); border-radius: 4px;
  padding: 8px; margin-top: 6px; display: flex; flex-direction: column; gap: 8px;
}
.heatmap-sidebar__editor-name {
  width: 100%; box-sizing: border-box; font-size: 13px; padding: 4px 6px;
  background: var(--surface-2, #1c1c1c); color: inherit;
  border: 1px solid var(--color-divider, #333); border-radius: 3px;
}
.heatmap-sidebar__track { position: relative; height: 34px; touch-action: none; }
.heatmap-sidebar__track-bar {
  height: 18px; border-radius: 3px; cursor: copy;
  border: 1px solid var(--color-divider, #333);
}
.heatmap-sidebar__handle {
  position: absolute; top: 14px; transform: translateX(-50%);
  width: 12px; height: 12px; padding: 0; cursor: grab;
  border: 2px solid var(--surface-1, #111); border-radius: 3px;
  box-shadow: 0 0 0 1px #0000008c;
}
.heatmap-sidebar__handle:before {
  content: ""; position: absolute; left: 50%; top: -6px;
  width: 1px; height: 6px; background: var(--text-secondary, #999);
}
.heatmap-sidebar__handle--selected {
  border-color: var(--accent-color, #4a9eff); z-index: 1;
}
.heatmap-sidebar__handle:active { cursor: grabbing; }
.heatmap-sidebar__stop-row { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.heatmap-sidebar__stop-row input[type="color"] {
  width: 28px; height: 24px; padding: 0; cursor: pointer;
  background: none; border: 1px solid var(--color-divider, #444); border-radius: 3px;
}
.heatmap-sidebar__stop-row input[type="number"] {
  width: 52px; font-size: 12px; padding: 3px 4px;
  background: var(--surface-2, #1c1c1c); color: inherit;
  border: 1px solid var(--color-divider, #333); border-radius: 3px;
}
.heatmap-sidebar__hint { font-size: 11px; color: var(--text-secondary, #999); margin: 0; }
.heatmap-sidebar__editor-actions { display: flex; gap: 10px; align-items: center; }
`;
var styleEl = null;
function injectCSS() {
  if (styleEl) return;
  styleEl = document.createElement("style");
  styleEl.textContent = CSS;
  document.head.appendChild(styleEl);
}
function removeCSS() {
  if (styleEl) {
    styleEl.remove();
    styleEl = null;
  }
}
var ARROW_LEFT = "M20,11V13H8L13.5,18.5L12.08,19.92L4.16,12L12.08,4.08L13.5,5.5L8,11H20Z";
function Icon({ path, size = 20 }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("svg", { viewBox: "0 0 24 24", width: size, height: size, fill: "currentColor", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: path }) });
}
function HeatmapSidebar({ onClose }) {
  const [, rerender] = (0, import_react.useState)(0);
  const layers2 = getLayers();
  (0, import_react.useEffect)(() => {
    injectCSS();
    setOnSettingsChange(() => rerender((n) => n + 1));
    return () => {
      setOnSettingsChange(null);
      removeCSS();
    };
  }, []);
  const allCount = useMapState((s) => s.locationCount);
  const selectedIds = useMapState((s) => s.selectedLocationIds);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "map-sidebar heatmap-sidebar", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("header", { className: "heatmap-sidebar__header", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { className: "icon-button", onClick: onClose, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Icon, { path: ARROW_LEFT }) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", { className: "heatmap-sidebar__title", children: "Heatmap" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { flex: 1 } }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { className: "heatmap-sidebar__reset", onClick: resetLayers, children: "Reset" })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "heatmap-sidebar__body", children: [
      layers2.map((l, i) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        LayerControls,
        {
          layer: l,
          index: i,
          allCount,
          selectionCount: selectedIds.size
        },
        l.id
      )),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { className: "heatmap-sidebar__add", onClick: addLayer, children: "Add heatmap" })
    ] })
  ] });
}
function LayerControls({
  layer: l,
  index,
  allCount,
  selectionCount
}) {
  const set = (patch) => updateLayer(l.id, patch);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "heatmap-sidebar__section", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "heatmap-sidebar__layer-header", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "input",
        {
          type: "checkbox",
          checked: l.visible,
          onChange: (e) => set({ visible: e.target.checked })
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "heatmap-sidebar__layer-title", children: [
        "Heatmap ",
        index + 1
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "button",
        {
          className: "heatmap-sidebar__reset",
          onClick: () => removeLayer(l.id),
          children: "Remove"
        }
      )
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      SelectorPicker,
      {
        ctl: {
          selector: selectorForPick2(l.source),
          choice: l.source,
          setChoice: (c) => set({ source: c }),
          allCount,
          selectionCount,
          saved: true
        }
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      Slider,
      {
        label: "Intensity",
        value: l.intensity,
        min: 0.1,
        max: 10,
        step: 0.1,
        onChange: (v) => set({ intensity: v })
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      Slider,
      {
        label: "Radius",
        value: l.radiusPixels,
        min: 1,
        max: 100,
        step: 1,
        onChange: (v) => set({ radiusPixels: v }),
        format: (v) => `${v}px`
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      Slider,
      {
        label: "Opacity",
        value: l.opacity,
        min: 0,
        max: 1,
        step: 0.05,
        onChange: (v) => set({ opacity: v })
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      Slider,
      {
        label: "Threshold",
        value: l.threshold,
        min: 0,
        max: 1,
        step: 0.01,
        onChange: (v) => set({ threshold: v })
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      GradientPicker,
      {
        layerId: l.id,
        gradientId: l.gradientId,
        onSelect: (id) => set({ gradientId: id })
      }
    )
  ] });
}
function GradientPicker({
  layerId,
  gradientId,
  onSelect
}) {
  const [editingId, setEditingId] = (0, import_react.useState)(null);
  const customs = getCustomGradients();
  const current = resolveGradient(gradientId, customs);
  const editing = customs.find((g) => g.id === editingId) ?? null;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "heatmap-sidebar__section-title", style: { marginTop: 8 }, children: "Gradient" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "heatmap-sidebar__gradients", children: [
      [...BUILTIN_GRADIENTS, ...customs].map((g) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "button",
        {
          className: `heatmap-sidebar__gradient ${g.id === current.id ? "heatmap-sidebar__gradient--active" : ""}`,
          onClick: () => onSelect(g.id),
          title: g.name,
          children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "div",
            {
              className: "heatmap-sidebar__gradient-bar",
              style: { background: gradientCss(g.stops) }
            }
          )
        },
        g.id
      )),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "button",
        {
          className: "heatmap-sidebar__gradient-new",
          onClick: () => setEditingId(addCustomGradient(layerId, current).id),
          title: "Create an editable copy of the selected gradient",
          children: "+ New"
        }
      )
    ] }),
    !isBuiltinGradient(current.id) && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
      "div",
      {
        className: "heatmap-sidebar__editor-actions",
        style: { marginTop: 6 },
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "button",
            {
              className: "heatmap-sidebar__reset",
              onClick: () => setEditingId(editing?.id === current.id ? null : current.id),
              children: editing?.id === current.id ? "Done" : "Edit gradient"
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "button",
            {
              className: "heatmap-sidebar__reset",
              onClick: () => removeCustomGradient(current.id),
              children: "Delete"
            }
          )
        ]
      }
    ),
    editing && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(GradientEditor, { gradient: editing })
  ] });
}
function GradientEditor({ gradient: g }) {
  const [selectedRaw, setSelected] = (0, import_react.useState)(0);
  const trackRef = (0, import_react.useRef)(null);
  const colorInputRef = (0, import_react.useRef)(null);
  const selected = Math.min(selectedRaw, g.stops.length - 1);
  const stop = g.stops[selected];
  const setStops = (stops) => updateCustomGradient(g.id, { stops });
  const posFromClientX = (clientX) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect?.width) return 0;
    return (clientX - rect.left) / rect.width;
  };
  const startDrag = (index) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.button !== 0) return;
    setSelected(index);
    const el = e.currentTarget;
    const from = g.stops;
    const onMove = (ev) => {
      const next = moveStop(from, index, posFromClientX(ev.clientX));
      setSelected(next.index);
      setStops(next.stops);
    };
    const onUp = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
    };
    el.setPointerCapture(e.pointerId);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  };
  const nudge = (index) => (e) => {
    const step = e.shiftKey ? 0.05 : 0.01;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const delta = e.key === "ArrowLeft" ? -step : step;
      const next = moveStop(g.stops, index, g.stops[index].pos + delta);
      setSelected(next.index);
      setStops(next.stops);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      setStops(removeStop(g.stops, index));
    }
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "heatmap-sidebar__editor", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "input",
      {
        className: "heatmap-sidebar__editor-name",
        value: g.name,
        onChange: (e) => updateCustomGradient(g.id, { name: e.target.value }),
        "aria-label": "Gradient name"
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "heatmap-sidebar__track", ref: trackRef, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "div",
        {
          className: "heatmap-sidebar__track-bar",
          style: { background: gradientCss(g.stops) },
          title: "Click to add a stop",
          onClick: (e) => {
            const next = addStopAt(g.stops, posFromClientX(e.clientX));
            setSelected(next.index);
            setStops(next.stops);
          }
        }
      ),
      g.stops.map((s, i) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "button",
        {
          className: `heatmap-sidebar__handle ${i === selected ? "heatmap-sidebar__handle--selected" : ""}`,
          style: { left: `${s.pos * 100}%`, background: rgbToHex(s.color) },
          onPointerDown: startDrag(i),
          onKeyDown: nudge(i),
          onDoubleClick: () => colorInputRef.current?.click(),
          onContextMenu: (e) => {
            e.preventDefault();
            setStops(removeStop(g.stops, i));
          },
          title: `${Math.round(s.pos * 100)}% \u2014 drag to move, right-click to remove`,
          "aria-label": `Stop ${i + 1} at ${Math.round(s.pos * 100)}%`
        },
        i
      ))
    ] }),
    stop && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "heatmap-sidebar__stop-row", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "input",
        {
          ref: colorInputRef,
          type: "color",
          value: rgbToHex(stop.color),
          onChange: (e) => setStops(
            setStopColor(g.stops, selected, hexToRgb(e.target.value))
          ),
          "aria-label": "Stop colour"
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "input",
        {
          type: "number",
          min: 0,
          max: 100,
          value: Math.round(stop.pos * 100),
          onChange: (e) => {
            const next = moveStop(
              g.stops,
              selected,
              Number(e.target.value) / 100
            );
            setSelected(next.index);
            setStops(next.stops);
          },
          "aria-label": "Stop position"
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "%" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { flex: 1 } }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "button",
        {
          className: "heatmap-sidebar__reset",
          onClick: () => setStops(reverseStops(g.stops)),
          children: "Reverse"
        }
      )
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "heatmap-sidebar__hint", children: g.stops.length <= MIN_STOPS ? `Click the bar to add a stop (${MIN_STOPS} minimum).` : "Click the bar to add a stop, right-click a handle to remove it." })
  ] });
}
function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format
}) {
  const display = format ? format(value) : String(Math.round(value * 100) / 100);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "heatmap-sidebar__control", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", { children: label }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "input",
      {
        type: "range",
        min,
        max,
        step,
        value,
        onChange: (e) => onChange(Number(e.target.value))
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "heatmap-sidebar__value", children: display })
  ] });
}

// heatmap/src/index.tsx
var { registerPlugin } = MMA;
registerPlugin({
  activate() {
    let cancelled = false;
    let teardown = null;
    (async () => {
      if (cancelled) return;
      teardown = await init();
    })();
    return () => {
      cancelled = true;
      teardown?.();
    };
  },
  sidebar: HeatmapSidebar
});
