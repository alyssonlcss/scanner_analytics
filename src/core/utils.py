"""
Core utility functions for data processing.

This module provides reusable utility functions for datetime operations,
column resolution, and data transformations.
"""

from typing import List, Optional, Any
from datetime import datetime
import pandas as pd
import numpy as np


class DateTimeUtils:
    """Utility class for datetime operations."""
    
    @staticmethod
    def parse_datetime(
        series: pd.Series,
        dayfirst: bool = True,
        errors: str = "coerce"
    ) -> pd.Series:
        """
        Parse a series of strings to datetime objects.
        
        Args:
            series: Pandas series containing date strings
            dayfirst: Whether to interpret ambiguous dates as day-first
            errors: How to handle parsing errors ('coerce', 'raise', 'ignore')
            
        Returns:
            Pandas series with datetime objects
        """
        return pd.to_datetime(series, dayfirst=dayfirst, errors=errors)
    
    @staticmethod
    def diff_minutes(a: Any, b: Any) -> Optional[float]:
        """
        Calculate the difference in minutes between two datetime objects.
        
        Args:
            a: First datetime (should be later)
            b: Second datetime (should be earlier)
            
        Returns:
            Difference in minutes, or None if either input is NaT/None
        """
        if pd.isna(a) or pd.isna(b):
            return np.nan
        return (a - b).total_seconds() / 60.0
    
    @staticmethod
    def extract_date(series: pd.Series) -> pd.Series:
        """
        Extract date component from datetime series.
        
        Args:
            series: Pandas series with datetime objects
            
        Returns:
            Pandas series with date objects
        """
        return pd.to_datetime(series, dayfirst=True, errors="coerce").dt.date
    
    @staticmethod
    def format_datetime(dt: datetime, fmt: str = "%d/%m/%Y %H:%M") -> str:
        """
        Format datetime object to string.
        
        Args:
            dt: Datetime object to format
            fmt: Format string
            
        Returns:
            Formatted datetime string
        """
        if pd.isna(dt):
            return ""
        return dt.strftime(fmt)


class ColumnResolver:
    """Utility class for resolving column names in DataFrames."""
    
    def __init__(self, dataframe: pd.DataFrame):
        """
        Initialize resolver with a DataFrame.
        
        Args:
            dataframe: DataFrame to resolve columns from
        """
        self._df = dataframe
        self._columns = set(dataframe.columns)
    
    def resolve(self, candidates: List[str]) -> Optional[str]:
        """
        Find the first matching column from a list of candidates.
        
        Args:
            candidates: List of possible column names in order of preference
            
        Returns:
            First matching column name, or None if no match found
        """
        for candidate in candidates:
            if candidate in self._columns:
                return candidate
        return None
    
    def resolve_all(self, mappings: dict) -> dict:
        """
        Resolve multiple column mappings at once.
        
        Args:
            mappings: Dictionary with key as target name and value as list of candidates
            
        Returns:
            Dictionary with resolved column names
        """
        return {
            key: self.resolve(candidates)
            for key, candidates in mappings.items()
        }
    
    def has_column(self, column: str) -> bool:
        """
        Check if a column exists in the DataFrame.
        
        Args:
            column: Column name to check
            
        Returns:
            True if column exists
        """
        return column in self._columns
    
    def get_columns(self) -> List[str]:
        """Return list of all column names."""
        return list(self._columns)


class DataFrameUtils:
    """Utility class for DataFrame operations."""
    
    @staticmethod
    def safe_round(series: pd.Series, decimals: int = 2) -> pd.Series:
        """
        Safely round numeric series, handling NaN values.
        
        Args:
            series: Pandas series to round
            decimals: Number of decimal places
            
        Returns:
            Rounded series
        """
        return series.round(decimals)
    
    @staticmethod
    def reorder_columns(
        df: pd.DataFrame,
        columns_to_move: List[str],
        before_column: str
    ) -> pd.DataFrame:
        """
        Reorder DataFrame columns, placing specified columns before a target column.
        
        Args:
            df: DataFrame to reorder
            columns_to_move: Columns to relocate
            before_column: Target column to place moved columns before
            
        Returns:
            DataFrame with reordered columns
        """
        if before_column not in df.columns:
            return df
        
        cols = [c for c in df.columns if c not in columns_to_move]
        
        if before_column in cols:
            idx = cols.index(before_column)
            existing_cols = [c for c in columns_to_move if c in df.columns]
            for col in reversed(existing_cols):
                cols.insert(idx, col)
        
        return df[[c for c in cols if c in df.columns]]
    
    @staticmethod
    def filter_by_status(
        df: pd.DataFrame,
        status_column: str,
        status_value: str,
        inverse: bool = False
    ) -> pd.DataFrame:
        """
        Filter DataFrame by status column value.
        
        Args:
            df: DataFrame to filter
            status_column: Name of status column
            status_value: Status value to filter by
            inverse: If True, return records NOT matching the status
            
        Returns:
            Filtered DataFrame
        """
        if status_column not in df.columns:
            return df if inverse else pd.DataFrame()
        
        mask = df[status_column].astype(str).str.strip().str.lower() == status_value.lower()
        
        return df[~mask].copy() if inverse else df[mask].copy()
