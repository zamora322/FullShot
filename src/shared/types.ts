import { ACTIONS } from './constants';

export interface ElementRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PageDimensions {
  scrollWidth: number;
  scrollHeight: number;
  clientWidth: number;
  clientHeight: number;
  devicePixelRatio: number;
  isElementScroll?: boolean;
  elementRect?: ElementRect;
  elementScrollHeight?: number;
  elementClientHeight?: number;
}

export interface CaptureProgress {
  percentage: number;
  currentStep: number;
  totalSteps: number;
}

export type ActionType = typeof ACTIONS[keyof typeof ACTIONS];

export interface MessagePayload {
  action: ActionType;
  dimensions?: PageDimensions;
  progress?: CaptureProgress;
  error?: string;
  
  // Para control de scroll
  y?: number;
  
  // Para el Offscreen Document
  dataUrl?: string;
  width?: number;
  height?: number;
  filename?: string;
}
