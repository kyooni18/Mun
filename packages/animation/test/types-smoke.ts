import { animate as animateCore, compileMotionPlan as compileCoreMotionPlan, spring as coreSpring } from '@mun/animation/core';
import { createInterpolator as createCssInterpolator } from '@mun/animation/interpolate/css';
import {
  FrameBudgetGovernor,
  MotionEngine,
  animateInterpolated,
  createPathMorpher,
  materials,
  motionValue,
  smooth,
  decay,
  inertia,
  animateVelocity,
  createDragController,
  type ColorInput,
  type MaterialInput,
} from '@mun/animation';
import { animateMaterial, animatePath, bindPointerDrag, bindStyleValue } from '@mun/animation/dom';
import { captureSharedLayout, createLayoutTransition, createSharedLayoutTransition, SharedLayoutRegistry } from '@mun/animation/layout';
import { createPathMorpher as createPathMorpherSubpath } from '@mun/animation/path';
import { VelocityTracker, createDragController as createDragControllerSubpath } from '@mun/animation/gesture';
import { resolveMaterial } from '@mun/animation/material';
import { SharedSpringWorkerBackend } from '@mun/animation/worker';
import { createSharedWasmMemory } from '@mun/animation/wasm';

const engine = new MotionEngine({
  autoStart: false,
  worker: 'auto',
  workerThreshold: 1024,
  adaptiveBackends: true,
  frameBudgetMs: 7,
});
const x = motionValue(0);
engine.animate(x, 10, smooth());
animateVelocity(x, decay({ velocity: 1200 }));
engine.animateVelocity(x, inertia({ velocity: 800, min: 0, max: 100 }));
void engine.stepAsync(16.67);
void engine.getBackendPlan();
const governor = new FrameBudgetGovernor({ budgetMs: 5 });
void governor.observe(2);
const color: ColorInput = '#fff';
animateInterpolated(color, '#000', smooth(), () => {}, { type: 'color', engine });
createPathMorpher('M0 0 L1 1', 'M0 0 L2 2');
createPathMorpherSubpath('M0 0 L1 1', 'M0 0 L2 2');
const material: MaterialInput = materials.glass;
void resolveMaterial(material);

declare const element: HTMLElement;
declare const svgPath: SVGPathElement;
bindStyleValue(element, 'width', x, { unit: 'px' });
const drag = createDragController({ x, axis: 'x', engine, bounds: { minX: 0, maxX: 100 } });
createDragControllerSubpath({ x, axis: 'x' });
new VelocityTracker().add(10, 16);
bindPointerDrag(element, drag);
animateMaterial(element, 'clear', 'glass', smooth(), { engine });
animatePath(svgPath, 'M0 0 L1 1', 'M0 0 L2 2', smooth(), { engine, precision: 3 });
createLayoutTransition(element, { engine, spec: smooth() });
void SharedSpringWorkerBackend.isSupported();
void createSharedWasmMemory;

const leanControl = animateCore(x, 1, compileCoreMotionPlan(coreSpring({ response: 0.2, dampingRatio: 1 })));
leanControl.cancel();
void createCssInterpolator('#000', '#fff', { type: 'color' })(0.5);

import { createPhaseTimeline, stagger, timeline as createTimeline } from '@mun/animation/timeline';
const timelineX = motionValue(0);
const clip = createTimeline()
  .track(timelineX, [0, 100, 20], { duration: 1 })
  .track((value: string) => void value, [
    { at: 0, value: '#fff' },
    { at: 1, value: '#000' },
  ], { type: 'color' });
const player = clip.player({ engine, iterations: 2, direction: 'alternate' });
player.seekProgress(0.5).play().reverse();
void player.finished;
const phases = createPhaseTimeline({ x: timelineX }, [
  { name: 'idle', values: { x: 0 } },
  { name: 'active', duration: 0.2, values: { x: 10 } },
]);
void phases.phaseAt(0.1);
void stagger(0.04, { from: 'center' })(2, 5);


import { createPresence, createStateTransitionGraph, createTransition } from '@mun/animation/transition';
import { createTimelineScrubber } from '@mun/animation/timeline';
const visibility = motionValue(0);
const transition = createTransition([{ key: 'opacity', target: visibility, from: 0, to: 1 }], { engine, present: false });
transition.enter();
const presence = createPresence(transition);
presence.setPresent(false);
const stateGraph = createStateTransitionGraph({ x: timelineX }, { a: { x: 0 }, b: { x: 100 } }, { initial: 'a', engine });
stateGraph.to('b');
const scrubber = createTimelineScrubber(player, { engine, min: 0, max: 300, snapPoints: [0, 300] });
scrubber.set(150).release({ velocity: 500 });
scrubber.dispose();
const sharedSnapshot = captureSharedLayout(element, { key: (node) => node.id });
createSharedLayoutTransition(sharedSnapshot, element, { engine, key: (node) => node.id });
new SharedLayoutRegistry({ engine, key: (node) => node.id });

import { createScrollTracker, observeScroll, bindScrollTimeline } from '@mun/animation/scroll';
import { createConstraintGraph } from '@mun/animation/constraints';
import { createCanvasRenderer } from '@mun/animation/canvas';
import { createWebGLUniformBinder } from '@mun/animation/webgl';
import { createWebGPUBufferBinder } from '@mun/animation/webgpu';
const scrollTracker = createScrollTracker({ start: 0, end: 1000 });
scrollTracker.sample(200, 16);
bindScrollTimeline(player, scrollTracker).dispose();
declare const scrollElement: HTMLElement;
observeScroll(scrollElement, { tracker: scrollTracker }).dispose();
const constraints = createConstraintGraph();
const constraintSource = constraints.node(x);
const constraintTargetValue = motionValue(0);
const constraintTarget = constraints.node(constraintTargetValue);
constraints.affine(constraintTarget, constraintSource, { scale: 2 }).compile().evaluate();
declare const canvasContext: CanvasRenderingContext2D;
createCanvasRenderer(canvasContext, [x], (_ctx, values) => void values[0]).dispose();
declare const webgl: WebGLRenderingContext;
declare const webglProgram: WebGLProgram;
createWebGLUniformBinder(webgl, webglProgram, [{ name: 'uX', value: x }]).dispose();
declare const gpuDeviceLike: { queue: { writeBuffer(...args: any[]): void } };
declare const gpuBufferLike: object;
createWebGPUBufferBinder(gpuDeviceLike, gpuBufferLike, [x]).dispose();
