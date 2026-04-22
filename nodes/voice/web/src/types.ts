export type SegmentEvent = {
  type: "segment";
  session_id: string;
  speaker_id: string;
  name: string;
  text: string;
  t_start: number;
  t_end: number;
  provisional: boolean;
  confidence: number;
};

export type SpeakerNewEvent = {
  type: "speaker_new";
  speaker_id: string;
  name: string;
};

export type SpeakerRenamedEvent = {
  type: "speaker_renamed";
  speaker_id: string;
  name: string;
};

export type StatusEvent = {
  type: "status";
  state: "idle" | "listening" | "error";
  message?: string;
};

export type VoiceEvent = SegmentEvent | SpeakerNewEvent | SpeakerRenamedEvent | StatusEvent;

export type Profile = {
  id: string;
  name: string;
  color: string;
  sample_count: number;
  voiceprint_count: number;
  created_at: string;
  updated_at: string;
};
