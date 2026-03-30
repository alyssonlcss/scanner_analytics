"""
Report generator for creating ABNT-formatted analysis reports.

This module generates comprehensive Word documents with team performance
analysis, metrics rankings, and recommendations.
"""

from typing import Optional, List, Tuple
from pathlib import Path
import pandas as pd
import numpy as np
import logging

from ..config import Settings, get_settings
from ..core.models import ProcessingResult
from .docx_builder import DocxBuilder

logger = logging.getLogger(__name__)


class ReportGenerator:
    """
    Generator for ABNT-formatted analysis reports.
    
    Creates comprehensive Word documents with team performance analysis,
    including rankings, metrics comparisons, and recommendations.
    """
    
    def __init__(self, settings: Optional[Settings] = None):
        """
        Initialize the report generator.
        
        Args:
            settings: Application settings. If None, uses default settings.
        """
        self._settings = settings or get_settings()
    
    def generate(
        self,
        result: ProcessingResult,
        col_equipe: str,
        output_path: Optional[Path] = None
    ) -> Optional[Path]:
        """
        Generate a complete analysis report.
        
        Args:
            result: Processing result containing aggregated data
            col_equipe: Name of the team column
            output_path: Optional custom output path
            
        Returns:
            Path to generated report, or None if generation failed
        """
        if not result.has_productive_data and not result.has_unproductive_data:
            logger.warning("No data available for report generation")
            return None
        
        output = output_path or self._settings.report_path
        
        logger.info("Generating ABNT report")
        
        builder = DocxBuilder()
        
        # Title and date
        builder.add_title("RELATÓRIO DE ANÁLISE DE DESEMPENHO DAS EQUIPES")
        builder.add_date()
        builder.add_space()
        
        # Introduction
        self._add_introduction(builder)
        
        # Methodology
        self._add_methodology(builder)
        builder.add_page_break()
        
        # Analysis sections
        section_num = 3
        
        if result.has_productive_data:
            self._add_analysis_section(
                builder,
                result.df_productive_averages,
                col_equipe,
                "PRODUTIVAS",
                section_num
            )
            section_num += 1
        
        if result.has_unproductive_data:
            self._add_analysis_section(
                builder,
                result.df_unproductive_averages,
                col_equipe,
                "IMPRODUTIVAS",
                section_num
            )
            section_num += 1
        
        # Conclusions
        self._add_conclusions(builder, section_num)
        
        # Save
        builder.save(str(output))
        
        return output
    
    def _add_introduction(self, builder: DocxBuilder) -> None:
        """Add introduction section."""
        builder.add_paragraph(
            bold_prefix="1. INTRODUÇÃO\n",
            text=(
                "Este relatório apresenta uma análise detalhada do desempenho das equipes "
                "operacionais, com foco nos principais indicadores de produtividade e "
                "eficiência. A análise é dividida em duas seções principais: registros "
                "produtivos e registros improdutivos, conforme classificação do sistema. "
                "Para cada métrica, as equipes são classificadas da pior para a melhor "
                "performance, com destaque para aquelas que apresentam desvios significativos "
                "em relação às metas estabelecidas."
            )
        )
        builder.add_space()
    
    def _add_methodology(self, builder: DocxBuilder) -> None:
        """Add methodology section."""
        builder.add_paragraph(
            bold_prefix="2. METODOLOGIA\n",
            text=(
                "As métricas foram calculadas com base nos registros de apontamento das "
                "equipes, considerando os seguintes parâmetros:"
            )
        )
        
        metrics = [
            f"TempExe: Tempo de execução (Liberada - No_Local) - Meta: {self._settings.metrics.temp_exe_productive}min (produtivo) / {self._settings.metrics.temp_exe_unproductive}min (improdutivo)",
            "TempDesl: Tempo de deslocamento (No_Local - A_Caminho)",
            f"InterReg: Intervalo regulamentar (Fim_Intervalo - Início_Intervalo) - Meta: {self._settings.metrics.intervalo_regulamentar}min",
            "TempPrep: Tempo de preparação da equipe",
            f"Tempo de utilização: TempExe + TempDesl - Meta: {self._settings.metrics.utilizacao_meta*100:.0f}% de {self._settings.metrics.jornada_total}min ({self._settings.metrics.tempo_util_meta:.1f}min)",
            "Tempo ocioso: TempPrep + (60 - InterReg) ou TempPrep + 60 (se InterReg = 0)",
        ]
        
        builder.add_bullet_list(metrics, italic=True)
    
    def _add_analysis_section(
        self,
        builder: DocxBuilder,
        df: pd.DataFrame,
        col_equipe: str,
        tipo: str,
        section_num: int
    ) -> None:
        """Add analysis section for a record type."""
        builder.add_section(str(section_num), f"ANÁLISE DE REGISTROS {tipo}")
        
        # Filter overall averages only
        df_geral = df[df[col_equipe].str.startswith("MédiaTodosDias", na=False)].copy()
        
        if df_geral.empty:
            builder.add_paragraph(f"Nenhum dado disponível para análise de registros {tipo}.")
            return
        
        # Clean team names
        df_geral["Equipe_Nome"] = df_geral[col_equipe].str.replace("MédiaTodosDias", "")
        
        subsection = 1
        
        # TempExe
        if "TempExe" in df_geral.columns:
            data = self._get_ranking_data(df_geral, "Equipe_Nome", "TempExe", ascending=False)
            meta = "50 min" if tipo == "PRODUTIVAS" else "20 min"
            builder.add_ranking_table(
                f"{section_num}.{subsection} Tempo de Execução (TempExe)",
                data,
                description=(
                    "Esta métrica indica o tempo médio de execução das atividades. "
                    "Valores muito baixos podem indicar erro de apontamento nos momentos "
                    "'No_Local' e 'Liberada'."
                )
            )
            subsection += 1
        
        # TempDesl
        if "TempDesl" in df_geral.columns:
            data = self._get_ranking_data(df_geral, "Equipe_Nome", "TempDesl", ascending=False)
            builder.add_ranking_table(
                f"{section_num}.{subsection} Tempo de Deslocamento (TempDesl)",
                data,
                description=(
                    "Esta métrica indica o tempo médio de deslocamento. "
                    "Valores muito baixos podem indicar erro de apontamento nos momentos "
                    "'A_Caminho' e 'No_Local'."
                )
            )
            subsection += 1
        
        # Tempo de Utilização
        if "TempExe" in df_geral.columns and "TempDesl" in df_geral.columns:
            self._add_utilization_table(builder, df_geral, section_num, subsection)
            subsection += 1
        
        # InterReg
        if "InterReg" in df_geral.columns:
            self._add_interval_table(builder, df_geral, section_num, subsection)
            subsection += 1
        
        # TempPrep
        if "TempPrep" in df_geral.columns:
            data = self._get_ranking_data(df_geral, "Equipe_Nome", "TempPrep", ascending=False)
            builder.add_ranking_table(
                f"{section_num}.{subsection} Tempo de Preparação (TempPrep)",
                data,
                description=(
                    "Tempo de preparação da equipe. Valores elevados indicam possível ociosidade "
                    "ou ineficiência no processo de preparação para novas atividades."
                )
            )
            subsection += 1
        
        # Tempo Ocioso
        if "TempPrep" in df_geral.columns and "InterReg" in df_geral.columns:
            self._add_idle_time_table(builder, df_geral, section_num, subsection)
        
        builder.add_page_break()
    
    def _get_ranking_data(
        self,
        df: pd.DataFrame,
        team_col: str,
        value_col: str,
        ascending: bool = True
    ) -> List[Tuple[str, float]]:
        """Get ranking data sorted by value."""
        df_sorted = df[[team_col, value_col]].dropna()
        df_sorted = df_sorted.sort_values(value_col, ascending=ascending)
        return list(zip(df_sorted[team_col], df_sorted[value_col]))
    
    def _add_utilization_table(
        self,
        builder: DocxBuilder,
        df: pd.DataFrame,
        section: int,
        subsection: int
    ) -> None:
        """Add utilization analysis table."""
        df = df.copy()
        df["Tempo_Utilizacao"] = df["TempExe"] + df["TempDesl"]
        df["Percentual_Utilizacao"] = (df["Tempo_Utilizacao"] / self._settings.metrics.jornada_total) * 100
        
        df_sorted = df[["Equipe_Nome", "Tempo_Utilizacao", "Percentual_Utilizacao"]].dropna()
        df_sorted = df_sorted.sort_values("Percentual_Utilizacao")
        
        builder.document.add_heading(f"{section}.{subsection} Tempo de Utilização", level=3)
        
        para = builder.document.add_paragraph()
        para.add_run(f"Meta: {self._settings.metrics.utilizacao_meta*100:.0f}% de {self._settings.metrics.jornada_total}min ({self._settings.metrics.tempo_util_meta:.1f}min)").bold = True
        
        builder.document.add_paragraph(
            "Tempo total de trabalho produtivo (execução + deslocamento). "
            "Valores abaixo de 85% indicam subutilização da jornada."
        )
        
        rows = [
            [str(idx + 1), row["Equipe_Nome"], f"{row['Tempo_Utilizacao']:.2f}", f"{row['Percentual_Utilizacao']:.1f}%"]
            for idx, (_, row) in enumerate(df_sorted.iterrows())
        ]
        
        builder.add_table(
            headers=["Posição", "Equipe", "Tempo (min)", "Utilização (%)"],
            rows=rows
        )
    
    def _add_interval_table(
        self,
        builder: DocxBuilder,
        df: pd.DataFrame,
        section: int,
        subsection: int
    ) -> None:
        """Add interval analysis table."""
        df = df.copy()
        df["Desvio_Meta"] = abs(df["InterReg"] - self._settings.metrics.intervalo_regulamentar)
        
        df_sorted = df[["Equipe_Nome", "InterReg", "Desvio_Meta"]].dropna()
        df_sorted = df_sorted.sort_values("Desvio_Meta", ascending=False)
        
        builder.document.add_heading(f"{section}.{subsection} Intervalo Regulamentar (InterReg)", level=3)
        
        para = builder.document.add_paragraph()
        para.add_run(f"Meta: {self._settings.metrics.intervalo_regulamentar}min (entre 4ª e 6ª hora)").bold = True
        
        builder.document.add_paragraph(
            "Intervalo para refeição. Desvios significativos podem indicar "
            "irregularidades no cumprimento da jornada de trabalho."
        )
        
        rows = [
            [str(idx + 1), row["Equipe_Nome"], f"{row['InterReg']:.2f}", f"{row['Desvio_Meta']:.2f}"]
            for idx, (_, row) in enumerate(df_sorted.iterrows())
        ]
        
        builder.add_table(
            headers=["Posição", "Equipe", "Intervalo (min)", "Desvio da Meta"],
            rows=rows
        )
    
    def _add_idle_time_table(
        self,
        builder: DocxBuilder,
        df: pd.DataFrame,
        section: int,
        subsection: int
    ) -> None:
        """Add idle time analysis table."""
        df = df.copy()
        df["Tempo_Ocioso"] = np.where(
            df["InterReg"] == 0,
            df["TempPrep"] + 60,
            df["TempPrep"] + (60 - df["InterReg"])
        )
        
        df_sorted = df[["Equipe_Nome", "Tempo_Ocioso"]].dropna()
        df_sorted = df_sorted.sort_values("Tempo_Ocioso", ascending=False)
        
        builder.document.add_heading(f"{section}.{subsection} Tempo Ocioso Total", level=3)
        
        builder.document.add_paragraph(
            "Soma do tempo de preparação com o tempo não utilizado do intervalo. "
            "Valores elevados indicam ociosidade operacional significativa."
        )
        
        rows = [
            [str(idx + 1), row["Equipe_Nome"], f"{row['Tempo_Ocioso']:.2f}"]
            for idx, (_, row) in enumerate(df_sorted.iterrows())
        ]
        
        builder.add_table(
            headers=["Posição", "Equipe", "Tempo Ocioso (min)"],
            rows=rows
        )
    
    def _add_conclusions(self, builder: DocxBuilder, section_num: int) -> None:
        """Add conclusions section."""
        builder.add_section(str(section_num), "CONCLUSÕES E RECOMENDAÇÕES")
        
        builder.add_paragraph(
            bold_prefix="Com base na análise realizada, observa-se que:\n\n",
            text=""
        )
        
        conclusions = [
            "As equipes com pior desempenho nas métricas de tempo devem receber atenção especial;",
            "Valores muito abaixo do padrão em TempExe e TempDesl sugerem necessidade de treinamento sobre apontamento correto;",
            "Tempos ociosos elevados indicam oportunidades de melhoria na gestão operacional;",
            "Desvios significativos no intervalo regulamentar requerem verificação do cumprimento da jornada de trabalho;",
            "Recomenda-se acompanhamento periódico destes indicadores para melhoria contínua.",
        ]
        
        for i, conclusion in enumerate(conclusions, 1):
            builder.add_paragraph(f"{i}. {conclusion}")
        
        builder.add_space()
        builder.add_paragraph(
            "Este relatório deve ser utilizado como base para planos de ação corretivos e preventivos."
        )
