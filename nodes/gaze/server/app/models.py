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
    sample_count: int = 0
    faceprint_count: int = 0
    created_at: str
    updated_at: str


class MergeIn(BaseModel):
    source_id: str
    target_id: str


class Bbox(BaseModel):
    x_min: float = Field(ge=0.0, le=1.0)
    y_min: float = Field(ge=0.0, le=1.0)
    x_max: float = Field(ge=0.0, le=1.0)
    y_max: float = Field(ge=0.0, le=1.0)


class GazePoint(BaseModel):
    x: float = Field(ge=0.0, le=1.0)
    y: float = Field(ge=0.0, le=1.0)


class DetectedFace(BaseModel):
    face_index: int
    profile_id: str | None = None
    name: str | None = None
    color: str | None = None
    bbox: Bbox
    eye_center: GazePoint | None = None
    gaze: GazePoint | None = None
    inout_score: float | None = None  # Gazelle: in-frame probability
    gaze_peak: float | None = None    # Gazelle: heatmap peak confidence
    looking_at: str | None = None
    looking_at_camera: bool = False
    looking_at_description: str | None = None
    match_confidence: float = 0.0
    provisional: bool = False


class DetectResponse(BaseModel):
    width: int
    height: int
    faces: list[DetectedFace]
    elapsed_ms: dict[str, float]


class DetectBase64In(BaseModel):
    image: str  # data URL or bare base64
    remember: bool = True  # whether to update/create profiles from this frame
    describe: bool = False  # call Moondream.query to label each gaze target


class GazeEvent(BaseModel):
    id: int
    ts: str
    source_profile_id: str | None = None
    target_type: str  # 'profile' | 'camera' | 'scene'
    target_profile_id: str | None = None
    description: str | None = None
    gaze_x: float | None = None
    gaze_y: float | None = None
