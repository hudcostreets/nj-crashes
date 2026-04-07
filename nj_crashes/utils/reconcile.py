"""Utilities for reconciling conflicting data mappings."""
from collections.abc import Callable, Sequence
from pandas import DataFrame, Series
from utz import err


def ambiguous_mappings(
    df: DataFrame,
    cols: Sequence[str],
) -> tuple[DataFrame, DataFrame]:
    """
    Find conflicts where key columns (all but last) map to multiple values (last col).

    Args:
        df: DataFrame to check for conflicts
        cols: List of column names - all but last are keys, last is the value

    Returns:
        (uniqs, conflicts):
            - uniqs: All unique (key, value) combinations
            - conflicts: Subset of uniqs where keys map to multiple values
    """
    uniqs = (
        df
        [cols]
        .drop_duplicates()
        .sort_values(cols)
    )
    hist = uniqs.value_counts(cols[:-1], sort=False)
    conflict_keys = hist[hist > 1]
    conflict_keys_df = conflict_keys.reset_index()[cols[:-1]]
    conflicts = uniqs.merge(conflict_keys_df, on=cols[:-1])
    return uniqs, conflicts


def resolve_conflicts(
    df: DataFrame,
    key_cols: Sequence[str],
    value_col: str,
    conflicts_df: DataFrame,
    threshold: float | None = None,
    resolver: str | Callable[[DataFrame], Series | DataFrame] = 'majority',
    verbose: bool = True,
) -> DataFrame:
    """
    Resolve conflicts in key→value mappings via configurable strategy.

    Args:
        df: DataFrame with record counts in 'num' column
        key_cols: List of column names that form the key (e.g., ['cc'] or ['cc', 'mc', 'year'])
        value_col: Column name with conflicting values (e.g., 'cn' or 'mn')
        conflicts_df: Conflicts detected by ambiguous_mappings
        threshold: If set, raise if top value isn't at least this many times 2nd place frequency
        resolver: Resolution strategy:
            - 'majority': Use most common value by record count (default)
            - callable(group_df) -> row: Custom resolution function that takes a grouped
              DataFrame (with columns: key_cols + value_col + 'num') and returns a single
              row with the resolved value
        verbose: If True, log conflicts and resolutions to stderr

    Returns:
        resolved_df: DataFrame with key_cols + [value_col] after resolution

    Examples:
        # Basic majority voting
        resolved = resolve_conflicts(
            df,
            key_cols=['cc'],
            value_col='cn',
            conflicts_df=conflicts
        )

        # With safety threshold (1st must be 10x 2nd place)
        resolved = resolve_conflicts(
            df,
            key_cols=['cc', 'mc', 'year'],
            value_col='mn',
            conflicts_df=conflicts,
            threshold=10
        )

        # Custom resolver using edit distance/fuzzy matching
        def fuzzy_resolver(group_df):
            # group_df has columns: key_cols + value_col + 'num'
            # Your custom logic here (clustering, ML, etc.)
            return group_df.iloc[0]  # Return single row

        resolved = resolve_conflicts(
            df,
            key_cols=['location'],
            value_col='standardized_location',
            conflicts_df=conflicts,
            resolver=fuzzy_resolver
        )
    """
    if len(conflicts_df) == 0:
        # No conflicts, just return unique mappings
        return df[key_cols + [value_col]].drop_duplicates()

    if verbose:
        err(f"Found {len(conflicts_df)} {'+'.join(key_cols)}→{value_col} conflicts, resolving via {resolver}:")

    # Group by key and value, sum record counts
    grouped = df.groupby(key_cols + [value_col])['num'].sum().reset_index()

    if resolver == 'majority':
        # Sort by count descending, take first (most common) for each key
        resolved = (
            grouped
            .sort_values('num', ascending=False)
            .drop_duplicates(key_cols, keep='first')
        )

        # Check threshold if specified
        if threshold is not None:
            for key_tuple in conflicts_df[key_cols].drop_duplicates().itertuples(index=False):
                key_dict = dict(zip(key_cols, key_tuple))
                mask = Series([True] * len(grouped))
                for k, v in key_dict.items():
                    mask &= (grouped[k] == v)
                counts = grouped[mask].sort_values('num', ascending=False)

                if len(counts) >= 2:
                    first, second = counts.iloc[0]['num'], counts.iloc[1]['num']
                    ratio = first / second if second > 0 else float('inf')
                    if ratio < threshold:
                        raise ValueError(
                            f"Conflict resolution failed threshold check for {key_dict}: "
                            f"top value has {first} records, 2nd has {second} (ratio {ratio:.1f} < {threshold})"
                        )

        if verbose:
            # Show what we're choosing
            for _, row in conflicts_df.iterrows():
                key_dict = {k: row[k] for k in key_cols}
                mask = Series([True] * len(grouped))
                for k, v in key_dict.items():
                    mask &= (grouped[k] == v)
                totals = grouped[mask].groupby(value_col)['num'].sum()
                err(f"  {', '.join(f'{k}={v}' for k, v in key_dict.items())}: {dict(totals)}")

        return resolved[key_cols + [value_col]]

    elif callable(resolver):
        # Custom resolution function
        def resolve_group(group):
            return resolver(group)

        resolved = grouped.groupby(key_cols, group_keys=False).apply(resolve_group).reset_index(drop=True)
        return resolved[key_cols + [value_col]]

    else:
        raise ValueError(f"Unknown resolver: {resolver}")
