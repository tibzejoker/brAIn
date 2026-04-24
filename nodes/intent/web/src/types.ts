export type Person = {
  id: string;
  name: string;
  color: string;
  voice_profile_id: string | null;
  gaze_profile_id: string | null;
  created_at: string;
  updated_at: string;
};

export type VoiceProfile = {
  id: string;
  name: string;
  color: string;
};

export type GazeProfile = {
  id: string;
  name: string;
  color: string;
};

export type Intent = {
  id: number;
  ts?: string;
  source_person_id: string | null;
  source_voice_profile_id: string | null;
  source_name: string | null;
  target_kind: "person" | "camera" | "scene" | "unknown";
  target_person_id: string | null;
  target_gaze_profile_id: string | null;
  target_name: string | null;
  text: string;
  t_start: number;
  t_end: number;
  confidence: number;
};

export type TimelineVoice = {
  ts: number;
  ts_end: number | null;
  person_id: string | null;
  voice_profile_id: string;
  voice_name: string;
  text: string;
  t_start: number;
  t_end: number;
  confidence: number;
  provisional: boolean;
};

export type TimelineGaze = {
  ts: number;
  target_kind: string;
  source_gaze_profile_id: string | null;
  target_gaze_profile_id: string | null;
  source_person_id: string | null;
  target_person_id: string | null;
  description: string | null;
  gaze_x: number | null;
  gaze_y: number | null;
};

export type TimelineSnapshot = {
  now: number;
  window_s: number;
  voice: TimelineVoice[];
  gaze: TimelineGaze[];
};
