"""
Aggregation service for computing team averages.

This module handles the aggregation of calculated metrics by team and date,
producing summary statistics for analysis.
"""

from typing import Optional, Dict, List
import pandas as pd
import numpy as np
import logging

from ..config import Settings, get_settings
from ..core.utils import DateTimeUtils

logger = logging.getLogger(__name__)


class AggregatorService:
    """
    Service for aggregating displacement metrics.
    
    Computes averages per team per day and overall team averages,
    supporting both productive and unproductive record filtering.
    """
    
    def __init__(self, settings: Optional[Settings] = None):
        """
        Initialize the aggregator service.
        
        Args:
            settings: Application settings. If None, uses default settings.
        """
        self._settings = settings or get_settings()
    
    def aggregate(
        self,
        df: pd.DataFrame,
        columns: Dict[str, Optional[str]],
        record_type: str = "produtivas"
    ) -> Optional[pd.DataFrame]:
        """
        Aggregate metrics by team and date.
        
        Args:
            df: DataFrame with calculated metrics
            columns: Resolved column name mappings
            record_type: Type of records ('produtivas' or 'improdutivas')
            
        Returns:
            DataFrame with aggregated averages, or None if aggregation fails
        """
        logger.info(f"Starting aggregation for {record_type} records")
        
        if df.empty:
            logger.warning(f"No {record_type} records to aggregate")
            return None
        
        col_equipe = columns.get("equipe")
        col_despachada = columns.get("despachada")
        
        if not col_equipe or col_equipe not in df.columns:
            logger.error("Column 'Equipe' not found in dataset")
            return None
        
        if not col_despachada or col_despachada not in df.columns:
            logger.error("Date column not found")
            return None
        
        # Extract date: prefer 'Data Referência' from CSV if present, otherwise use resolved 'despachada'
        try:
            df = df.copy()
            date_source = None
            if "Data Referência" in df.columns:
                date_source = "Data Referência"
            elif col_despachada and col_despachada in df.columns:
                date_source = col_despachada
            else:
                # fallback to any column named 'Data' if present
                if "Data" in df.columns:
                    date_source = "Data"

            if date_source is None:
                logger.error("No suitable date column found (Data Referência / despachada)")
                return None

            df["Data Referência"] = pd.to_datetime(
                df[date_source], dayfirst=True, errors="coerce"
            ).dt.date
        except Exception as e:
            logger.error(f"Failed to extract dates: {e}")
            return None
        
        # Get calculated columns that exist
        calc_cols = [
            col for col in self._settings.calculated.all_columns
            if col in df.columns
        ]

        if not calc_cols:
            logger.error("No calculated columns found in dataset")
            return None

        logger.info(f"Aggregating columns: {', '.join(calc_cols)}")
        logger.info(f"Total {record_type} records: {len(df)}")

        # Group and calculate means + count
        # Agrupamento apenas por colunas literais do CSV
        temp_sem_ordem_col = getattr(self._settings.calculated, 'sem_ordem_jornada', 'SemOrdemJornada')
        # Group by team and the chosen date column 'Data Referência'
        group_keys = [col_equipe, "Data Referência"]
        calc_cols_no_tempsemordem = [col for col in calc_cols if col != temp_sem_ordem_col]
        averages = df.groupby(group_keys)[calc_cols_no_tempsemordem].mean().round(2).reset_index()
        # Adiciona SemOrdemJornada por grupo (média)
        if temp_sem_ordem_col in df.columns:
            semordemjornada_mean = df.groupby(group_keys)[temp_sem_ordem_col].mean().reset_index()
            averages = averages.merge(semordemjornada_mean, on=[col_equipe, "Data Referência"], how="left")

        # Add order count per team per day
        order_count = df.groupby(group_keys).size().reset_index(name="qtd_ordem")
        averages = averages.merge(order_count, on=group_keys, how="left")

        # Add 'Retorno a base' (first non-null value per group)
        col_retorno_base = columns.get("retorno_base")
        if col_retorno_base and col_retorno_base in df.columns:
            retorno_base = df.groupby(group_keys)[col_retorno_base].first().reset_index()
            averages = averages.merge(retorno_base, on=group_keys, how="left")
            averages.rename(columns={col_retorno_base: "Retorno a base"}, inplace=True)
        
        # Rename columns to indicate averages (use same names as calculated columns)
        # e.g. TempExe -> TempExe
        rename_map = {col: col for col in calc_cols}
        averages = averages.rename(columns=rename_map)

        # Compute utilization (HT/HD) per group and HT_Faltante (minutes missing to reach meta)
        # Attempt to detect HT and HD total columns in original dataframe
        ht_col = None
        hd_col = None
        for c in df.columns:
            c_norm = c.lower().replace(" ", "")
            if "ht" in c_norm and "total" in c_norm and ht_col is None:
                ht_col = c
            if "hd" in c_norm and "total" in c_norm and hd_col is None:
                hd_col = c

        if ht_col and hd_col:
            # First non-null value per group (these totals are per-day/team and usually repeated)
            ht_vals = df.groupby(group_keys)[ht_col].first().reset_index()
            hd_vals = df.groupby(group_keys)[hd_col].first().reset_index()

            # Normalize numeric values (commas as decimal separators)
            def _to_num(s):
                try:
                    return float(str(s).replace(',', '.'))
                except Exception:
                    return float('nan')

            ht_vals[ht_col] = ht_vals[ht_col].apply(_to_num)
            hd_vals[hd_col] = hd_vals[hd_col].apply(_to_num)

            util_df = ht_vals.merge(hd_vals, on=group_keys, how='left')
            util_df[ht_col] = ht_vals[ht_col]
            util_df[hd_col] = hd_vals[hd_col]

            util_df['Utilizacao'] = util_df.apply(
                lambda r: (r[ht_col] / r[hd_col]) * 100 if r[hd_col] and not pd.isna(r[hd_col]) and r[hd_col] != 0 else float('nan'),
                axis=1
            )

            # HT_Faltante: minutes missing to reach meta (meta = utilizacao_meta * HD)
            meta_frac = getattr(self._settings.metrics, 'utilizacao_meta', 0.85)
            util_df['HT_Faltante'] = util_df.apply(
                lambda r: max(0.0, (meta_frac * r[hd_col]) - r[ht_col]) if not pd.isna(r[ht_col]) and not pd.isna(r[hd_col]) else float('nan'),
                axis=1
            )

            # Merge Utilizacao, HT_Faltante and raw HT/HD into averages (use 'Data Referência' column)
            util_merge_cols = [col_equipe, 'Data Referência', 'Utilizacao', 'HT_Faltante']
            # include raw totals if available for team-level aggregation
            if ht_col:
                util_merge_cols.append(ht_col)
            if hd_col:
                util_merge_cols.append(hd_col)

            averages = averages.merge(util_df[util_merge_cols], on=[col_equipe, 'Data Referência'], how='left')
        
        # Sort by team and date
        averages = averages.sort_values([col_equipe, "Data Referência"])
        
        # Add overall averages per team. Include new aggregated columns if present.
        calc_cols_for_totals = list(calc_cols)
        if 'Utilizacao' in averages.columns:
            calc_cols_for_totals.append('Utilizacao')
        if 'HT_Faltante' in averages.columns:
            calc_cols_for_totals.append('HT_Faltante')

        averages = self._add_team_totals(averages, col_equipe, calc_cols_for_totals)
        
        # Log statistics
        self._log_statistics(averages, col_equipe, record_type)
        
        return averages
    
    def _add_team_totals(
        self,
        df: pd.DataFrame,
        col_equipe: str,
        calc_cols: List[str]
    ) -> pd.DataFrame:
        """Add overall average rows for each team."""
        result_frames = []
        teams = df[col_equipe].unique()
        
        logger.info(f"Processing {len(teams)} teams...")
        
        for team in teams:
            team_data = df[df[col_equipe] == team].copy()
            result_frames.append(team_data)
            
            # Calculate overall average for team
            overall_avg = {}
            for col in calc_cols:
                col_media = f"{col}"
                if col_media in team_data.columns:
                    values = team_data[col_media].dropna()
                    overall_avg[col_media] = round(values.mean(), 2) if len(values) > 0 else np.nan

            # Para Utilizacao, manter cálculo pela soma dos totais
            ht_col_name = None
            hd_col_name = None
            for c in team_data.columns:
                c_norm = str(c).lower().replace(" ", "")
                if "ht" in c_norm and "total" in c_norm and ht_col_name is None:
                    ht_col_name = c
                if "hd" in c_norm and "total" in c_norm and hd_col_name is None:
                    hd_col_name = c

            if ht_col_name and hd_col_name:
                ht_sum = pd.to_numeric(team_data[ht_col_name].astype(str).str.replace(",", "."), errors="coerce").sum()
                hd_sum = pd.to_numeric(team_data[hd_col_name].astype(str).str.replace(",", "."), errors="coerce").sum()
                if hd_sum and not pd.isna(hd_sum) and hd_sum != 0:
                    overall_avg['Utilizacao'] = round((ht_sum / hd_sum) * 100, 2)
                else:
                    overall_avg['Utilizacao'] = np.nan

            # Para HT_Faltante, usar a média dos valores diários
            if 'HT_Faltante' in team_data.columns:
                ht_faltante_vals = team_data['HT_Faltante'].dropna()
                overall_avg['HT_Faltante'] = round(ht_faltante_vals.mean(), 2) if len(ht_faltante_vals) > 0 else np.nan

            # Calculate mean for 'Retorno a base' if present
            if "Retorno a base" in team_data.columns:
                retorno_vals = team_data["Retorno a base"].dropna()
                # Converter para float, ignorando erros
                retorno_vals_num = pd.to_numeric(retorno_vals.astype(str).str.replace(",", "."), errors="coerce")
                overall_avg["Retorno a base"] = round(retorno_vals_num.mean(), 2) if len(retorno_vals_num.dropna()) > 0 else np.nan

            # Calculate total orders for team
            total_orders = team_data["qtd_ordem"].sum() if "qtd_ordem" in team_data.columns else 0

            # Create overall row
            # Use 'Data Referência' as the date column for the overall row
            date_key = 'Data Referência' if 'Data Referência' in team_data.columns else ('Data' if 'Data' in team_data.columns else 'Data Referência')
            overall_row = {
                col_equipe: f"MédiaTodosDias{team}",
                date_key: "GERAL",
                "qtd_ordem": int(total_orders),
            }
            overall_row.update(overall_avg)

            result_frames.append(pd.DataFrame([overall_row]))
            
            logger.debug(f"  - {team}: {len(team_data)} days processed")
        
        if result_frames:
            combined = pd.concat(result_frames, ignore_index=True)
            # Remove raw HT/HD total columns from final output to keep previous shape
            cols_to_drop = [c for c in combined.columns if isinstance(c, str) and 'ht' in c.lower() and 'total' in c.lower()]
            cols_to_drop += [c for c in combined.columns if isinstance(c, str) and 'hd' in c.lower() and 'total' in c.lower()]
            if cols_to_drop:
                combined = combined.drop(columns=cols_to_drop, errors='ignore')
            return combined
        
        return pd.DataFrame()
    
    def _log_statistics(
        self,
        df: pd.DataFrame,
        col_equipe: str,
        record_type: str
    ) -> None:
        """Log aggregation statistics."""
        if df.empty:
            return
        
        # Count teams (excluding 'MédiaTodosDias' rows)
        regular_rows = df[~df[col_equipe].str.startswith("MédiaTodosDias", na=False)]
        total_rows = df[df[col_equipe].str.startswith("MédiaTodosDias", na=False)]
        
        teams = regular_rows[col_equipe].nunique()
        days = regular_rows["Data"].nunique() if "Data" in regular_rows else 0
        
        logger.info(f"\nStatistics for {record_type}:")
        logger.info(f"- Total teams: {teams}")
        logger.info(f"- Days with records: {days}")
        logger.info(f"- Daily records: {len(regular_rows)}")
        logger.info(f"- 'MédiaTodosDias' rows added: {len(total_rows)}")
        logger.info(f"- Total rows in output: {len(df)}")
    
    def filter_by_status(
        self,
        df: pd.DataFrame,
        columns: Dict[str, Optional[str]]
    ) -> tuple:
        """
        Filter DataFrame into productive and unproductive records.
        
        Args:
            df: DataFrame with calculated metrics
            columns: Resolved column name mappings
            
        Returns:
            Tuple of (productive_df, unproductive_df)
        """
        col_status = columns.get("status")
        
        if not col_status or col_status not in df.columns:
            logger.warning("Status column not found, treating all as productive")
            return df.copy(), pd.DataFrame()
        
        mask = df[col_status].astype(str).str.strip().str.lower() == "improdutivo"
        
        df_unproductive = df[mask].copy()
        df_productive = df[~mask].copy()
        
        logger.info(f"Total records: {len(df)}")
        logger.info(f"Unproductive records: {len(df_unproductive)}")
        logger.info(f"Productive records: {len(df_productive)}")
        
        return df_productive, df_unproductive
