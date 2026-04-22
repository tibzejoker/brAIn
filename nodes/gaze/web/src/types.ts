export type Profile = {
  id: string;
  name: string;
  color: string;
  sample_count: number;
  faceprint_count: number;
  created_at: string;
  updated_at: string;
};

export type Bbox = {
  x_min: number;
  y_min: number;
  x_max: number;
  y_max: number;
};

export type GazePoint = {
  x: number;
  y: number;
};

export type DetectedFace = {
  face_index: number;
  profile_id: string | null;
  name: string | null;
  color: string | null;
  bbox: Bbox;
  gaze: GazePoint | null;
  looking_at: string | null;
  match_confidence: number;
  provisional: boolean;
};

export type DetectResponse = {
  width: number;
  height: number;
  faces: DetectedFace[];
  elapsed_ms: { detect: number; match: number; gaze: number };
};

export type Tuning = {
  match_threshold: number;
  uncertain_threshold: number;
  ema_decay: number;
  looking_at_margin: number;
};

export type Faceprint = {
  id: string;
  sample_count: number;
  created_at: string;
  updated_at: string;
};
