from pydantic import BaseModel, Field


class PersonIn(BaseModel):
    name: str
    color: str | None = None
    voice_profile_id: str | None = None
    gaze_profile_id: str | None = None


class PersonPatch(BaseModel):
    name: str | None = None
    color: str | None = None
    voice_profile_id: str | None = None
    gaze_profile_id: str | None = None


class Person(BaseModel):
    id: str
    name: str
    color: str
    voice_profile_id: str | None = None
    gaze_profile_id: str | None = None
    created_at: str
    updated_at: str


class IntentRecord(BaseModel):
    id: int
    ts: str
    source_person_id: str | None          # linked person, or None if unknown
    source_voice_profile_id: str | None
    source_name: str | None
    target_kind: str                      # 'person' | 'camera' | 'scene' | 'unknown'
    target_person_id: str | None
    target_gaze_profile_id: str | None    # the face profile looked at
    target_name: str | None
    text: str
    t_start: float
    t_end: float
    confidence: float = Field(ge=0.0, le=1.0)


class TimelineEntry(BaseModel):
    kind: str  # 'voice' | 'gaze'
    ts: float  # float epoch seconds
    person_id: str | None
    voice_profile_id: str | None = None
    gaze_profile_id: str | None = None
    text: str | None = None
    t_start: float | None = None
    t_end: float | None = None
    target_kind: str | None = None
    target_gaze_profile_id: str | None = None
