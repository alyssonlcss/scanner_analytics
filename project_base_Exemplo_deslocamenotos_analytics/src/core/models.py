"""
Domain models and data transfer objects.

This module defines the core data structures used throughout the application,
following Domain-Driven Design principles.
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional, List, Dict, Any
from enum import Enum
import pandas as pd


class RecordStatus(Enum):
    """Status classification for displacement records."""
    
    PRODUCTIVE = "produtivo"
    UNPRODUCTIVE = "improdutivo"
    UNKNOWN = "desconhecido"


@dataclass
class DisplacementRecord:
    """
    Domain model representing a single displacement record.
    
    This model encapsulates all timing information for a team's
    service dispatch, travel, and execution cycle.
    """
    
    # Identification
    equipe: str
    
    # Timestamps
    despachada: Optional[datetime] = None
    a_caminho: Optional[datetime] = None
    no_local: Optional[datetime] = None
    liberada: Optional[datetime] = None
    inicio_intervalo: Optional[datetime] = None
    fim_intervalo: Optional[datetime] = None
    inicio_calendario: Optional[datetime] = None
    primeiro_login: Optional[datetime] = None
    
    # Previous record references (for team continuity)
    prev_liberada: Optional[datetime] = None
    prev_despachada: Optional[datetime] = None
    
    # Calculated metrics (in minutes)
    temp_prep_equipe: Optional[float] = None
    temp_exe: Optional[float] = None
    temp_desl: Optional[float] = None
    inter_reg: Optional[float] = None
    atras_login: Optional[float] = None
    
    # Status
    status: RecordStatus = RecordStatus.UNKNOWN
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert record to dictionary representation."""
        return {
            "equipe": self.equipe,
            "despachada": self.despachada,
            "a_caminho": self.a_caminho,
            "no_local": self.no_local,
            "liberada": self.liberada,
            "temp_prep_equipe": self.temp_prep_equipe,
            "temp_exe": self.temp_exe,
            "temp_desl": self.temp_desl,
            "inter_reg": self.inter_reg,
            "atras_login": self.atras_login,
            "status": self.status.value,
        }


@dataclass
class TeamAverages:
    """
    Aggregated averages for a team over a specific period.
    
    Contains calculated metrics averages per team per day,
    with support for overall team averages.
    """
    
    equipe: str
    data: Optional[str] = None  # Date string or 'GERAL' for overall
    
    # Average metrics
    media_temp_prep_equipe: Optional[float] = None
    media_temp_exe: Optional[float] = None
    media_temp_desl: Optional[float] = None
    media_inter_reg: Optional[float] = None
    media_atras_login: Optional[float] = None
    
    # Derived metrics
    tempo_utilizacao: Optional[float] = None
    percentual_utilizacao: Optional[float] = None
    tempo_ocioso: Optional[float] = None
    
    def calculate_derived_metrics(self, jornada_total: float = 468.0) -> None:
        """Calculate derived metrics from base averages."""
        if self.media_temp_exe is not None and self.media_temp_desl is not None:
            self.tempo_utilizacao = self.media_temp_exe + self.media_temp_desl
            self.percentual_utilizacao = (self.tempo_utilizacao / jornada_total) * 100
        
        if self.media_temp_prep_equipe is not None and self.media_inter_reg is not None:
            if self.media_inter_reg == 0:
                self.tempo_ocioso = self.media_temp_prep_equipe + 60
            else:
                self.tempo_ocioso = self.media_temp_prep_equipe + (60 - self.media_inter_reg)


@dataclass
class ProcessingResult:
    """
    Result container for the displacement processing pipeline.
    
    Encapsulates all outputs from a processing run including
    DataFrames, statistics, and status information.
    """
    
    # Output DataFrames
    df_calculated: Optional[pd.DataFrame] = None
    df_productive_averages: Optional[pd.DataFrame] = None
    df_unproductive_averages: Optional[pd.DataFrame] = None
    
    # Statistics
    total_records: int = 0
    productive_records: int = 0
    unproductive_records: int = 0
    total_teams: int = 0
    processing_errors: List[str] = field(default_factory=list)
    
    # Status
    success: bool = False
    message: str = ""
    
    @property
    def has_productive_data(self) -> bool:
        """Check if productive data is available."""
        return self.df_productive_averages is not None and not self.df_productive_averages.empty
    
    @property
    def has_unproductive_data(self) -> bool:
        """Check if unproductive data is available."""
        return self.df_unproductive_averages is not None and not self.df_unproductive_averages.empty


@dataclass
class ReportMetadata:
    """Metadata for generated reports."""
    
    title: str = "RELATÓRIO DE ANÁLISE DE DESEMPENHO DAS EQUIPES"
    author: str = "Sistema de Análise de Deslocamento"
    generated_at: datetime = field(default_factory=datetime.now)
    version: str = "1.0.0"
