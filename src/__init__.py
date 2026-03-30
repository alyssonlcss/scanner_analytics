"""
Displacement Analysis Application.

A modular Python application for computing and analyzing team displacement metrics.
"""

__version__ = "1.0.0"
__author__ = "Alysson"

from .config import Settings, get_settings
from .core import DisplacementRecord, TeamAverages, ProcessingResult
from .services import ProcessingPipeline
from .reports import ReportGenerator

__all__ = [
    "Settings",
    "get_settings",
    "DisplacementRecord",
    "TeamAverages",
    "ProcessingResult",
    "ProcessingPipeline",
    "ReportGenerator",
]
