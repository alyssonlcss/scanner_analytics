"""
Data loading service for CSV file ingestion.

This module handles reading and initial parsing of displacement data files,
with robust handling of various encodings and column name variations.
"""

from pathlib import Path
from typing import Optional, Dict
import pandas as pd
import logging

from ..config import Settings, get_settings
from ..core.utils import ColumnResolver

logger = logging.getLogger(__name__)


class DataLoaderService:
    """
    Service for loading displacement data from CSV files.
    
    Handles file reading, encoding detection, and initial column mapping
    to normalize data for downstream processing.
    """
    
    def __init__(self, settings: Optional[Settings] = None):
        """
        Initialize the data loader service.
        
        Args:
            settings: Application settings. If None, uses default settings.
        """
        self._settings = settings or get_settings()
        self._column_resolver: Optional[ColumnResolver] = None
        self._resolved_columns: Dict[str, Optional[str]] = {}
    
    def load(self, file_path: Optional[Path] = None) -> pd.DataFrame:
        """
        Load displacement data from a CSV file.
        
        Args:
            file_path: Path to the CSV file. If None, uses default from settings.
            
        Returns:
            DataFrame with loaded data
            
        Raises:
            FileNotFoundError: If the specified file doesn't exist
            ValueError: If the file cannot be parsed
        """
        path = file_path or self._settings.input_path
        
        logger.info(f"Loading data from: {path}")
        
        if not path.exists():
            raise FileNotFoundError(f"Input file not found: {path}")
        
        try:
            # Try to detect encoding and separator
            # First try UTF-16 (common for Excel exports), then fallback to latin1
            encodings_to_try = ['utf-16', 'utf-8-sig', self._settings.files.encoding_input, 'utf-8']
            
            df = None
            last_error = None
            
            for encoding in encodings_to_try:
                try:
                    df = pd.read_csv(
                        path,
                        dtype=str,
                        encoding=encoding,
                        sep=None,  # Auto-detect separator
                        engine='python'  # Required for sep=None
                    )
                    logger.info(f"Successfully loaded with encoding: {encoding}")
                    break
                except Exception as e:
                    last_error = e
                    continue
            
            if df is None:
                raise last_error or ValueError("Failed to load CSV with any encoding")
            
            logger.info(f"Loaded {len(df)} records with {len(df.columns)} columns")
            
            # Initialize column resolver
            self._column_resolver = ColumnResolver(df)
            self._resolve_columns()
            
            return df
            
        except Exception as e:
            logger.error(f"Failed to load file: {e}")
            raise ValueError(f"Failed to parse CSV file: {e}")
    
    def _resolve_columns(self) -> None:
        """Resolve all column mappings based on settings."""
        if self._column_resolver is None:
            return
        
        col_settings = self._settings.columns
        
        self._resolved_columns = {
            "despachada": self._column_resolver.resolve(col_settings.despachada),
            "a_caminho": self._column_resolver.resolve(col_settings.a_caminho),
            "no_local": self._column_resolver.resolve(col_settings.no_local),
            "liberada": self._column_resolver.resolve(col_settings.liberada),
            "inicio_intervalo": self._column_resolver.resolve(col_settings.inicio_intervalo),
            "fim_intervalo": self._column_resolver.resolve(col_settings.fim_intervalo),
            "inicio_calendario": self._column_resolver.resolve(col_settings.inicio_calendario),
            "primeiro_login": self._column_resolver.resolve(col_settings.primeiro_login),
            "login_alt": self._column_resolver.resolve(col_settings.login_alt),
            "equipe": self._column_resolver.resolve(col_settings.equipe),
            "status": self._column_resolver.resolve(col_settings.status),
            # Colunas já existentes no CSV
            "tr_ordem": self._column_resolver.resolve(col_settings.tr_ordem),
            "tl_ordem": self._column_resolver.resolve(col_settings.tl_ordem),
            "tempo_padrao": self._column_resolver.resolve(col_settings.tempo_padrao),
            "hd_total": self._column_resolver.resolve(col_settings.hd_total),
            "fim_calendario": self._column_resolver.resolve(col_settings.fim_calendario),
            "retorno_base": self._column_resolver.resolve(col_settings.retorno_base),
        }
        
        logger.debug(f"Resolved columns: {self._resolved_columns}")
    
    @property
    def resolved_columns(self) -> Dict[str, Optional[str]]:
        """Get the resolved column mappings."""
        return self._resolved_columns
    
    def get_column(self, key: str) -> Optional[str]:
        """
        Get a resolved column name by key.
        
        Args:
            key: The column key (e.g., 'despachada', 'equipe')
            
        Returns:
            The resolved column name, or None if not found
        """
        return self._resolved_columns.get(key)
