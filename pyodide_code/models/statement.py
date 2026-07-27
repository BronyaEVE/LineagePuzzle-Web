from enum import Enum

from pydantic import BaseModel, Field


class StatementType(str, Enum):
    CREATE = "CREATE"
    INSERT = "INSERT"
    UPDATE = "UPDATE"
    DELETE = "DELETE"
    MERGE = "MERGE"
    UNKNOWN = "UNKNOWN"


class Statement(BaseModel):
    seq: int = Field(..., description="语句序号，从 1 开始")
    type: StatementType
    text: str = Field(..., description="语句文本")
    tables_referenced: list[str] = Field(default_factory=list)
    tables_created: list[str] = Field(default_factory=list)
    tables_modified: list[str] = Field(default_factory=list)


class StatementGroup(BaseModel):
    group_id: str
    original_script: str = Field(..., description="原始脚本全文")
    preprocessed_script: str = Field(..., description="预处理后的脚本")
    statements: list[Statement] = Field(default_factory=list)
