from typing import Literal

from pydantic import BaseModel, Field


class ProfileIn(BaseModel):
    name: str
    color: str | None = None


class ProfilePatch(BaseModel):
    name: str | None = None
    color: str | None = None


class Profile(BaseModel):
    id: str
    name: str
    color: str
    created_at: str
    updated_at: str
    sample_count: int = 0


class MergeIn(BaseModel):
    source_id: str
    target_id: str


class ControlIn(BaseModel):
    action: Literal["start", "stop", "status"]
    session_id: str | None = None


class SegmentEvent(BaseModel):
    type: Literal["segment"] = "segment"
    session_id: str
    speaker_id: str
    name: str
    text: str
    t_start: float
    t_end: float
    provisional: bool = False
    confidence: float = Field(ge=0.0, le=1.0)


class SpeakerNewEvent(BaseModel):
    type: Literal["speaker_new"] = "speaker_new"
    speaker_id: str
    name: str


class SpeakerRenamedEvent(BaseModel):
    type: Literal["speaker_renamed"] = "speaker_renamed"
    speaker_id: str
    name: str


class StatusEvent(BaseModel):
    type: Literal["status"] = "status"
    state: Literal["idle", "listening", "error"]
    message: str | None = None
