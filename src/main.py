"""
Main entry point for the displacement analysis application.

This module provides the main execution flow, coordinating all services
to process displacement data and generate reports.

Usage:
    python -m src.main
    # or
    python src/main.py
"""

import sys
import logging
from pathlib import Path

# Add src to path for imports when running directly
sys.path.insert(0, str(Path(__file__).parent.parent))

from src.config import get_settings
from src.services import ProcessingPipeline
from src.reports import ReportGenerator


def setup_logging(level: int = logging.INFO) -> None:
    """
    Configure application logging.
    
    Args:
        level: Logging level (default: INFO)
    """
    logging.basicConfig(
        level=level,
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )


def print_banner() -> None:
    """Print application banner."""
    print("=" * 60)
    print("  SISTEMA DE ANÁLISE DE DESLOCAMENTO DE EQUIPES")
    print("  Versão 1.0.0")
    print("=" * 60)


def print_summary(result) -> None:
    """Print execution summary."""
    print("\n" + "=" * 60)
    print("RESUMO DA EXECUÇÃO")
    print("=" * 60)
    
    settings = get_settings()
    
    print(f"1. Arquivo Excel de análise: {Path(settings.output_calculated_path).parent / 'analise_apontamento.xlsx'}")
    print(f"2. Relatório ABNT gerado: {settings.report_path}")
    
    print(f"\nEstatísticas:")
    print(f"  - Total de registros: {result.total_records}")
    print(f"  - Registros produtivos: {result.productive_records}")
    print(f"  - Registros improdutivos: {result.unproductive_records}")
    print(f"  - Total de equipes: {result.total_teams}")
    
    if result.success:
        print("\n✓ Processamento concluído com sucesso!")
    else:
        print(f"\n✗ Processamento falhou: {result.message}")
        if result.processing_errors:
            print("Erros:")
            for error in result.processing_errors:
                print(f"  - {error}")


def main() -> int:
    """
    Main entry point.
    
    Returns:
        Exit code (0 for success, 1 for failure)
    """
    setup_logging()
    print_banner()
    
    settings = get_settings()
    logger = logging.getLogger(__name__)
    
    try:
        # Initialize pipeline
        pipeline = ProcessingPipeline(settings)
        
        # Run processing
        logger.info("Starting displacement analysis pipeline")
        result = pipeline.run()
        
        if not result.success:
            logger.error(f"Pipeline failed: {result.message}")
            print_summary(result)
            return 1

        # Exporta apenas o arquivo Excel consolidado, modular
        try:
            sheets = []
            if result.df_calculated is not None:
                sheets.append(("Deslocamento Calculado", result.df_calculated, {"summary_identifier": "", "freeze_header": True}))
            if getattr(result, 'df_geral_averages', None) is not None:
                sheets.append(("Média Geral", result.df_geral_averages, {"summary_identifier": "GERAL", "freeze_header": True}))
            if result.df_unproductive_averages is not None:
                sheets.append(("Médias Improdutivas", result.df_unproductive_averages, {"summary_identifier": "GERAL", "freeze_header": True}))
            pipeline.export_analysis_excel(sheets)
            logger.info("Arquivo analise_apontamento.xlsx gerado com sucesso.")
            print("✓ Arquivo analise_apontamento.xlsx gerado com sucesso!")
        except Exception as e:
            logger.error(f"Falha ao exportar analise_apontamento.xlsx: {e}")
            print(f"✗ Falha ao exportar analise_apontamento.xlsx: {e}")
        
        # Generate report
        logger.info("=" * 60)
        logger.info("GENERATING REPORT")
        logger.info("=" * 60)
        
        if result.has_productive_data or result.has_unproductive_data:
            generator = ReportGenerator(settings)
            col_equipe = pipeline.loader.get_column("equipe")
            
            if col_equipe:
                report_path = generator.generate(result, col_equipe)
                if report_path:
                    logger.info(f"Report generated: {report_path}")
                    print("✓ Relatório gerado com sucesso!")
                else:
                    logger.warning("Report generation failed")
            else:
                logger.warning("Team column not found, skipping report")
        else:
            logger.warning("No data available for report generation")
        
        print_summary(result)
        return 0
        
    except Exception as e:
        logger.exception("Unexpected error during execution")
        print(f"\n✗ Erro inesperado: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
