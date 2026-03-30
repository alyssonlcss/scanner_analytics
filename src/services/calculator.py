"""
Calculator service for computing displacement metrics.

This module contains the business logic for calculating various time-based
metrics from displacement records.
"""

from typing import Optional, Dict, List
import pandas as pd
import numpy as np
import logging

from ..config import Settings, get_settings
from ..core.utils import DateTimeUtils

logger = logging.getLogger(__name__)


class CalculatorService:
    """
    Service for calculating displacement metrics.
    
    Implements all time-based calculations for team performance analysis,
    including preparation time, execution time, displacement time, and more.
    """
    
    def __init__(self, settings: Optional[Settings] = None):
        """
        Initialize the calculator service.
        
        Args:
            settings: Application settings. If None, uses default settings.
        """
        self._settings = settings or get_settings()
        self._dt_utils = DateTimeUtils()
    
    def process(
        self,
        df: pd.DataFrame,
        columns: Dict[str, Optional[str]]
    ) -> pd.DataFrame:
        """
        Process DataFrame and calculate all metrics.
        
        Args:
            df: Input DataFrame with raw displacement data
            columns: Resolved column name mappings
            
        Returns:
            DataFrame with calculated metrics added
        """
        logger.info("Starting metric calculations")
        
        # Create a copy to avoid modifying original
        result = df.copy()

        # Note: datetime parsing is performed locally within calculations; global *_dt
        # columns and parsing logic were removed per user request.

        # Calculate metrics
        result = self._calculate_temp_prep_equipe(result)
        result = self._copy_temp_exe(result, columns)
        result = self._copy_temp_desl(result, columns)
        # TempoPadrao and Jornada logic/columns removed per user request
        result = self._calculate_sem_ordem_jornada(result, columns)

        # Round calculated columns
        result = self._round_calculated_columns(result)

        # Reorder columns
        result = self._reorder_columns(result, columns)

        logger.info("Metric calculations completed")

        return result
    
    def _calculate_temp_prep_equipe(self, df: pd.DataFrame) -> pd.DataFrame:
        """
        Calcula TempPrep conforme regra detalhada do usuário, usando apenas colunas literais do CSV.
        """
        calc_col = self._settings.calculated.temp_prep_equipe
        col_equipe = "Equipe"
        col_dataref = "Data Referência"
        col_a_caminho = "A_Caminho"
        col_despachada = "Despachada"
        col_liberada = "Liberada"
        col_primeiro_desloc = "1º Desloc"
        col_intervalo = "Intervalo"
        col_inicio_intervalo = "Inicio Intervalo"
        col_fim_intervalo = "Fim Intervalo"

        # Ordena por equipe, data e A_Caminho — parse temporário sem criar _dt permanentes
        if col_a_caminho in df.columns:
            tmp_series = pd.to_datetime(df[col_a_caminho], dayfirst=True, errors='coerce')
            df = df.assign(_tmp_a_caminho=tmp_series).sort_values([col_equipe, col_dataref, '_tmp_a_caminho']).drop(columns=['_tmp_a_caminho']).copy()

        df[calc_col] = np.nan


        for (equipe, dataref), grupo in df.groupby([col_equipe, col_dataref]):
            # sort group by parsed A_Caminho without creating persistent _dt column
            if col_a_caminho in grupo.columns:
                grupo = grupo.assign(_tmp_a = pd.to_datetime(grupo[col_a_caminho], dayfirst=True, errors='coerce'))
                grupo = grupo.sort_values('_tmp_a').reset_index().drop(columns=['_tmp_a'])
            else:
                grupo = grupo.reset_index()
            temp_prep_list = []
            is_inter_a_caminho = False

            # Primeira ordem: valor da coluna "1º Desloc"
            try:
                temp_prep_val = float(str(grupo.loc[0, col_primeiro_desloc]).replace(',', '.'))
            except Exception:
                temp_prep_val = float('nan')
            temp_prep_list.append(temp_prep_val)

            # Para as demais ordens
            for i in range(1, len(grupo)):
                try:
                    a_caminho = pd.to_datetime(grupo.loc[i, col_a_caminho], dayfirst=True, errors='coerce')
                    despachada = pd.to_datetime(grupo.loc[i, col_despachada], dayfirst=True, errors='coerce')
                    liberada = pd.to_datetime(grupo.loc[i-1, col_liberada], dayfirst=True, errors='coerce')
                    inicio_intervalo = pd.to_datetime(grupo.loc[i, col_inicio_intervalo], dayfirst=True, errors='coerce') if col_inicio_intervalo in grupo.columns else pd.NaT
                    fim_intervalo = pd.to_datetime(grupo.loc[i, col_fim_intervalo], dayfirst=True, errors='coerce') if col_fim_intervalo in grupo.columns else pd.NaT
                    intervalo = grupo.loc[i, col_intervalo] if col_intervalo in grupo.columns else None
                    intervalo_float = float(str(intervalo).replace(',', '.')) if pd.notna(intervalo) and intervalo != '' else None
                except Exception:
                    a_caminho = despachada = liberada = inicio_intervalo = fim_intervalo = None
                    intervalo_float = None

                desconta_intervalo = False
                if pd.notna(despachada) and pd.notna(liberada) and despachada > liberada:
                    temp_prep = (a_caminho - despachada).total_seconds() / 60.0 if pd.notna(a_caminho) and pd.notna(despachada) else float('nan')
                    if (
                        pd.notna(inicio_intervalo) and pd.notna(fim_intervalo)
                        and inicio_intervalo >= despachada - pd.Timedelta(minutes=10) and fim_intervalo <= a_caminho + pd.Timedelta(minutes=10) and not is_inter_a_caminho
                    ):
                        is_inter_a_caminho = True
                        desconta_intervalo = True
                else:
                    temp_prep = (a_caminho - liberada).total_seconds() / 60.0 if pd.notna(a_caminho) and pd.notna(liberada) else float('nan')
                    if (
                        pd.notna(inicio_intervalo) and pd.notna(fim_intervalo)
                        and inicio_intervalo >= liberada - pd.Timedelta(minutes=10) and fim_intervalo <= a_caminho + pd.Timedelta(minutes=10) and not is_inter_a_caminho
                    ):
                        is_inter_a_caminho = True
                        desconta_intervalo = True

                if desconta_intervalo and intervalo_float is not None and intervalo_float >= 0:
                    # desconta até 60 minutos e add o excedente acima de 60 minutos
                    temp_prep -= min(intervalo_float, 60.0)
                    excedente = intervalo_float - 60.0
                    if excedente > 0:
                        temp_prep += excedente
                    # não deixa negativo
                    if temp_prep < 0:
                        temp_prep = 0.0
                 

                temp_prep_list.append(temp_prep)

            # Atribui os valores calculados ao DataFrame original
            df.loc[grupo['index'], calc_col] = temp_prep_list

            # Adiciona TempPrepJornada: somatória da lista temp_prep_list (mesma lógica de SemOrdemJornada)
            try:
                # converte para array numérico, ignora NaN ao somar
                total_temp_prep = float(np.nansum([float(x) for x in temp_prep_list if x is not None and x != '' and not (isinstance(x, float) and np.isnan(x))]))
            except Exception:
                total_temp_prep = float('nan')
            df.loc[grupo['index'], 'TempPrepJornada'] = total_temp_prep

        df[calc_col] = pd.to_numeric(df[calc_col], errors='coerce')
        return df
    
    def _copy_temp_exe(self, df: pd.DataFrame, columns: Dict[str, Optional[str]]) -> pd.DataFrame:
        """Copy TempExe from TR Ordem column (already exists in CSV)."""
        calc_col = self._settings.calculated.temp_exe
        col_tr_ordem = columns.get("tr_ordem")
        
        if col_tr_ordem and col_tr_ordem in df.columns:
            # Convert to numeric, handling comma as decimal separator
            df[calc_col] = pd.to_numeric(
                df[col_tr_ordem].astype(str).str.replace(",", "."),
                errors="coerce"
            )
            logger.info(f"TempExe copied from '{col_tr_ordem}'")
        else:
            logger.warning("TR Ordem column not found, TempExe will be NaN")
            df[calc_col] = np.nan
        
        return df
    
    def _copy_temp_desl(self, df: pd.DataFrame, columns: Dict[str, Optional[str]]) -> pd.DataFrame:
        """Copy TempDesl from TL Ordem column (already exists in CSV)."""
        calc_col = self._settings.calculated.temp_desl
        col_tl_ordem = columns.get("tl_ordem")
        
        if col_tl_ordem and col_tl_ordem in df.columns:
            # Convert to numeric, handling comma as decimal separator
            df[calc_col] = pd.to_numeric(
                df[col_tl_ordem].astype(str).str.replace(",", "."),
                errors="coerce"
            )
            logger.info(f"TempDesl copied from '{col_tl_ordem}'")
        else:
            logger.warning("TL Ordem column not found, TempDesl will be NaN")
            df[calc_col] = np.nan
        
        return df
    
    def _copy_tempo_padrao(self, df: pd.DataFrame, columns: Dict[str, Optional[str]]) -> pd.DataFrame:
        """Legacy: TempoPadrao is kept as source column 'tempo_padrao' — no calculated column created."""
        # No action: keep original 'tempo_padrao' column from CSV; user requested to remove TempoPadrao logic/column.
        return df
    
    def _calculate_jornada(self, df: pd.DataFrame, columns: Dict[str, Optional[str]]) -> pd.DataFrame:
        """Calculate Jornada_min = Fim Calendario - Inicio Calendario."""
        calc_col = self._settings.calculated.jornada
        col_fim_calendario = columns.get("fim_calendario")
        
        if col_fim_calendario and col_fim_calendario in df.columns:
            # Parse Fim Calendario
            df["FimCalendario_dt"] = self._dt_utils.parse_datetime(df[col_fim_calendario])
        
        if "FimCalendario_dt" in df.columns and "InicioCalendario_dt" in df.columns:
            df[calc_col] = df.apply(
                lambda row: self._dt_utils.diff_minutes(
                    row["FimCalendario_dt"], row["InicioCalendario_dt"]
                ),
                axis=1
            )
            logger.info("Jornada_min calculated (Fim Calendario - Inicio Calendario)")
        else:
            logger.warning("Fim/Inicio Calendario columns not found, Jornada_min will be NaN")
            df[calc_col] = np.nan
        
        return df
    
    
    

    def _calculate_sem_ordem_jornada(
        self,
        df: pd.DataFrame,
        columns: Dict[str, Optional[str]]
    ) -> pd.DataFrame:
        """
        Calcula SemOrdemJornada (total do dia) e SemOSentreOS (entre cada ordem).
        """
        col_jornada = "SemOrdemJornada"
        col_entreos = "SemOSentreOS"
        col_equipe = "Equipe"
        col_dataref = "Data Referência"
        col_despachada = "Despachada"
        col_liberada = "Liberada"
        col_primeiro_despacho = "1º Despacho"
        col_intervalo = "Intervalo"
        col_inicio_intervalo = "Inicio Intervalo"
        col_fim_intervalo = "Fim Intervalo"

        # Ordena por equipe, data e A_Caminho (parse temporário sem criar _dt permanentes)
        if "A_Caminho" in df.columns:
            tmp_series = pd.to_datetime(df["A_Caminho"], dayfirst=True, errors='coerce')
            df = df.assign(_tmp_a_caminho=tmp_series).sort_values([col_equipe, col_dataref, '_tmp_a_caminho']).drop(columns=['_tmp_a_caminho']).copy()

        df[col_jornada] = np.nan
        df[col_entreos] = np.nan

        for (equipe, dataref), grupo in df.groupby([col_equipe, col_dataref]):
            # sort group by parsed A_Caminho without creating persistent _dt column
            if "A_Caminho" in grupo.columns:
                grupo = grupo.assign(_tmp_a = pd.to_datetime(grupo["A_Caminho"], dayfirst=True, errors='coerce'))
                grupo = grupo.sort_values('_tmp_a').reset_index().drop(columns=['_tmp_a'])
            else:
                grupo = grupo.reset_index()
            entre_ordem = 0.0
            is_inter_ordem = False
            entreos_list = []
            # Primeira ordem do dia: valor da coluna "1º Despacho"
            try:
                temp_sem_ordem_val = float(str(grupo.loc[0, col_primeiro_despacho]).replace(',', '.'))
                inicio_intervalo = pd.to_datetime(grupo.loc[0, col_inicio_intervalo], dayfirst=True, errors='coerce') if col_inicio_intervalo in grupo.columns else pd.NaT
                fim_intervalo = pd.to_datetime(grupo.loc[0, col_fim_intervalo], dayfirst=True, errors='coerce') if col_fim_intervalo in grupo.columns else pd.NaT
                intervalo = grupo.loc[0, col_intervalo] if col_intervalo in grupo.columns else None
                intervalo_float = float(str(intervalo).replace(',', '.')) if pd.notna(intervalo) and intervalo != '' else None
            except Exception:
                temp_sem_ordem_val = float('nan') 
                inicio_intervalo = fim_intervalo = pd.NaT
                intervalo_float = None

            # Primeira ordem: valor direto
            try:
                entreos_list.append(float(str(grupo.loc[0, col_primeiro_despacho]).replace(',', '.')))
            except Exception:
                entreos_list.append(float('nan'))

            # Calcula entre_ordem e verifica intervalo entre Liberada e Despachada
            for i in range(1, len(grupo)):
                try:
                    despachada = pd.to_datetime(grupo.loc[i, col_despachada], dayfirst=True, errors='coerce')
                    liberada = pd.to_datetime(grupo.loc[i-1, col_liberada], dayfirst=True, errors='coerce')
                except Exception:
                    despachada = liberada = pd.NaT
                entreos = float('nan')
                desconta_intervalo = False
                if pd.notna(despachada) and pd.notna(liberada) and despachada > liberada:
                    entreos = (despachada - liberada).total_seconds() / 60.0
                    # Verifica se o intervalo está totalmente entre liberada e despachada
                    if (
                        pd.notna(inicio_intervalo) and pd.notna(fim_intervalo)
                        and inicio_intervalo >= liberada - pd.Timedelta(minutes=10) and fim_intervalo <= despachada + pd.Timedelta(minutes=10) and not is_inter_ordem
                    ):
                        is_inter_ordem = True
                        desconta_intervalo = True

                # Ajusta o entreos para descontar o intervalo na célula específica (mesma regra de TempPrep)
                if desconta_intervalo and intervalo_float is not None and intervalo_float >= 0 and pd.notna(entreos):
                    entreos -= min(intervalo_float, 60.0)
                    excedente = intervalo_float - 60.0
                    if excedente > 0:
                        entreos += excedente
                    if entreos < 0:
                        entreos = 0.0

                # Acumula o (possivelmente ajustado) entreos
                if pd.notna(entreos):
                    entre_ordem += entreos
                entreos_list.append(entreos)

            # Soma o total de entre-ordens (já ajustado por célula quando necessário)
            temp_sem_ordem_val += entre_ordem

            # Repete o valor para todas as ordens da equipe/data
            df.loc[grupo['index'], col_jornada] = temp_sem_ordem_val
            # Preenche SemOSentreOS para cada ordem
            df.loc[grupo['index'], col_entreos] = entreos_list

        df[col_jornada] = pd.to_numeric(df[col_jornada], errors='coerce')
        df[col_entreos] = pd.to_numeric(df[col_entreos], errors='coerce')
        return df
    
    def _round_calculated_columns(self, df: pd.DataFrame) -> pd.DataFrame:
        """Round all calculated columns to 2 decimal places."""
        for col in self._settings.calculated.all_columns:
            if col in df.columns:
                df[col] = df[col].round(2)
        return df
    
    def _reorder_columns(
        self,
        df: pd.DataFrame,
        columns: Dict[str, Optional[str]]
    ) -> pd.DataFrame:
        """Reorder columns to the user-specified sequence for output.

        Keeps other columns in their original order after the specified sequence.
        """
        # Allow overriding the desired output order via settings.output_columns_order
        if hasattr(self._settings, "output_columns_order") and self._settings.output_columns_order:
            desired_order = list(self._settings.output_columns_order)
        else:
            desired_order = [
                "Nr_Ordem","status","TempPrep","TempPrepJornada",
                "TempExe","TempDesl","HD Total","SemOrdemJornada","SemOSentreOS",
                "Despachada","A_Caminho","No_Local","Liberada","HT Ordem","tempo_padrao"
            ]

        existing = list(df.columns)
        # Determine which desired columns exist and their original positions
        present_desired = [c for c in desired_order if c in existing]
        if not present_desired:
            return df

        # Find insertion index: the smallest index among present desired columns
        indices = [existing.index(c) for c in present_desired]
        insert_at = min(indices)

        # Build list without the present desired columns
        remaining = [c for c in existing if c not in present_desired]

        # Insert desired columns in the requested order at the original first position
        new_cols = remaining[:insert_at] + present_desired + remaining[insert_at:]
        return df.reindex(columns=new_cols)
