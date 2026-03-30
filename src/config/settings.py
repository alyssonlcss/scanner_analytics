"""
Application settings and configuration management.

This module provides centralized configuration using the Settings pattern,
enabling easy customization and environment-specific overrides.
"""

from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional
import os


@dataclass(frozen=True)
class PathSettings:
    """File and directory path configurations."""
    
    base_dir: Path = field(default_factory=lambda: Path(__file__).parent.parent.parent)
    src_dir: Path = field(default_factory=lambda: Path(__file__).parent.parent)
    data_dir: Path = field(default_factory=lambda: Path(__file__).parent.parent / "data")
    output_dir: Path = field(default_factory=lambda: Path(__file__).parent.parent.parent / "result")
    
    def __post_init__(self):
        """Ensure output directory exists."""
        self.output_dir.mkdir(parents=True, exist_ok=True)


@dataclass(frozen=True)
class FileSettings:
    """Input/output file configurations."""
    
    input_file: str = "deslocamentos.csv"
    output_calculated: str = "deslocamento_calculado.xlsx"
    output_productive_averages: str = "medias_por_equipe_dia.xlsx"
    output_unproductive_averages: str = "medias_Improdutivas_por_equipe_dia.xlsx"
    report_file: str = "relatorio_analise_equipes.docx"
    encoding_input: str = "latin1"
    encoding_output: str = "utf-8"


@dataclass(frozen=True)
class ColumnMappings:
    """Column name mappings for robust CSV parsing."""
    
    despachada: List[str] = field(default_factory=lambda: ["Despachada"])
    a_caminho: List[str] = field(default_factory=lambda: ["A_Caminho"])
    no_local: List[str] = field(default_factory=lambda: ["No_Local"])
    liberada: List[str] = field(default_factory=lambda: ["Liberada"])
    inicio_intervalo: List[str] = field(default_factory=lambda: [
        "Inicio Intervalo", "Início Intervalo", "Inicio_Intervalo", "Início_Intervalo"
    ])
    fim_intervalo: List[str] = field(default_factory=lambda: ["Fim Intervalo", "Fim_Intervalo"])
    inicio_calendario: List[str] = field(default_factory=lambda: [
        "Inicio Calendario", "Início Calendario", "Inicio_Calendario", "Início_Calendario"
    ])
    primeiro_login: List[str] = field(default_factory=lambda: [
        "1º Login", "1º LogIn", "1º Login Corrigido"
    ])
    login_alt: List[str] = field(default_factory=lambda: ["Log In", "Login"])
    equipe: List[str] = field(default_factory=lambda: ["Equipe"])
    status: List[str] = field(default_factory=lambda: [
        "status", "Status", "Situação", "Estado", "Tipo", "Classificação", "Categoria"
    ])
    # Colunas já existentes no CSV que serão usadas diretamente
    tr_ordem: List[str] = field(default_factory=lambda: ["TR Ordem", "TR_Ordem"])
    tl_ordem: List[str] = field(default_factory=lambda: ["TL Ordem", "TL_Ordem"])
    tempo_padrao: List[str] = field(default_factory=lambda: ["tempo_padrao", "Tempo_Padrao", "Tempo Padrao"])
    hd_total: List[str] = field(default_factory=lambda: ["HT total", "HD Total", "HD_Total"])
    fim_calendario: List[str] = field(default_factory=lambda: ["Fim Calendario", "Fim_Calendario"])
    retorno_base: List[str] = field(default_factory=lambda: ["Retorno a base", "Retorno Base", "Retorno_Base", "retorno_base"])


@dataclass(frozen=True)
class CalculatedColumns:
    """Names for calculated output columns."""
    
    temp_prep_equipe: str = "TempPrep"
    temp_prep_jornada: str = "TempPrepJornada"
    temp_exe: str = "TempExe"
    temp_desl: str = "TempDesl"
    inter_reg: str = "InterReg"
    sem_ordem_jornada: str = "SemOrdemJornada"
    # Colunas copiadas do CSV original
    tempo_padrao: str = "TempoPadrao"
    
    @property
    def all_columns(self) -> List[str]:
        """Return all calculated column names."""
        return [
            self.temp_prep_equipe,
            self.temp_prep_jornada,
            self.temp_exe,
            self.temp_desl,
            self.inter_reg,
            self.sem_ordem_jornada,
            "SemOSentreOS",
            # tempo_padrao remains as source CSV column; not treated as calculated here
        ]


@dataclass(frozen=True)
class MetricsTargets:
    """Target values for metrics analysis."""
    
    temp_exe_productive: float = 50.0  # minutes
    temp_exe_unproductive: float = 20.0  # minutes
    intervalo_regulamentar: float = 60.0  # minutes
    jornada_total: float = 468.0  # minutes (7h48min)
    utilizacao_meta: float = 0.85  # 85%
    
    @property
    def tempo_util_meta(self) -> float:
        """Calculate target utilization time."""
        return self.jornada_total * self.utilizacao_meta


@dataclass
class Settings:
    """Main application settings container."""
    
    paths: PathSettings = field(default_factory=PathSettings)
    files: FileSettings = field(default_factory=FileSettings)
    columns: ColumnMappings = field(default_factory=ColumnMappings)
    calculated: CalculatedColumns = field(default_factory=CalculatedColumns)
    metrics: MetricsTargets = field(default_factory=MetricsTargets)
    # Optional custom output column order. If empty, the default ordering logic is used.
    output_columns_order: List[str] = field(default_factory=list)
    
    @property
    def input_path(self) -> Path:
        """Full path to input file."""
        return self.paths.data_dir / self.files.input_file
    
    @property
    def output_calculated_path(self) -> Path:
        """Full path to calculated output file."""
        return self.paths.output_dir / self.files.output_calculated
    
    @property
    def output_productive_path(self) -> Path:
        """Full path to productive averages file."""
        return self.paths.output_dir / self.files.output_productive_averages
    
    @property
    def output_unproductive_path(self) -> Path:
        """Full path to unproductive averages file."""
        return self.paths.output_dir / self.files.output_unproductive_averages
    
    @property
    def report_path(self) -> Path:
        """Full path to report file."""
        return self.paths.output_dir / self.files.report_file


# Singleton pattern for settings
_settings_instance: Optional[Settings] = None


def get_settings() -> Settings:
    """Get or create the settings singleton instance."""
    global _settings_instance
    if _settings_instance is None:
        _settings_instance = Settings()
        # Attempt to load .env file from project root (base_dir)
        try:
            base = _settings_instance.paths.base_dir
            env_path = base / ".env"
            env_values = {}
            if env_path.exists():
                with env_path.open("r", encoding="utf-8") as fh:
                    for raw in fh:
                        line = raw.strip()
                        if not line or line.startswith("#"):
                            continue
                        if "=" not in line:
                            continue
                        k, v = line.split("=", 1)
                        env_values[k.strip()] = v.strip().strip('"').strip("'")

            # Map OUTPUT_COLUMNS_ORDER (comma-separated) to settings
            if "OUTPUT_COLUMNS_ORDER" in env_values:
                cols = [c.strip() for c in env_values["OUTPUT_COLUMNS_ORDER"].split(",") if c.strip()]
                _settings_instance.output_columns_order = cols

            # Map Excel theme environment variables (optional), supporting per-table prefixes
            theme_keys = {
                "HEADER_BG": "header_bg",
                "HEADER_FG": "header_fg",
                "ROW_EVEN": "row_even",
                "ROW_ODD": "row_odd",
                "TEAM_FILL_COLOR": "team_fill_color",
                "DATE_FONT_TRUE": "date_font_true",
                "DATE_FONT_FALSE": "date_font_false",
                "SUMMARY_BG": "summary_bg",
                "SUMMARY_FG": "summary_fg",
                # Flags
                "DISABLE_TEAM_ZEBRA": "disable_team_zebra",
                "DISABLE_DATE_ZEBRA": "disable_date_zebra",
            }

            def build_theme(prefix: str = "EXCEL_"):
                t = {}
                for suffix, key in theme_keys.items():
                    env_k = f"{prefix}{suffix}"
                    if env_k in env_values:
                        t[key] = env_values[env_k]
                return t

            default_theme = build_theme("EXCEL_")
            medias_theme = build_theme("EXCEL_MEDIAS_")
            medias_prod_theme = build_theme("EXCEL_MEDIAS_PRODUTIVAS_")
            medias_improd_theme = build_theme("EXCEL_MEDIAS_IMPRODUTIVAS_")
            medias_geral_theme = build_theme("EXCEL_MEDIAS_GERAL_")
            desloc_theme = build_theme("EXCEL_DESLOCAMENTO_")

            # Attach themes to settings for consumers
            _settings_instance.excel_themes = {
                "default": default_theme,
                "medias": medias_theme,
                "medias_produtivas": medias_prod_theme,
                "medias_geral": medias_geral_theme,
                "medias_improdutivas": medias_improd_theme,
                "deslocamento": desloc_theme,
            }
            # Backwards compatibility
            _settings_instance.excel_theme = default_theme
        except Exception:
            # If env parsing fails, continue with defaults
            _settings_instance.excel_themes = {"default": {}, "medias": {}}
            _settings_instance.excel_theme = {}
    return _settings_instance
