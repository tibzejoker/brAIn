import { useState, useEffect, useCallback } from "react";
import type { NodeTypeConfig } from "../api/types";
import { getTypes } from "../api/client";

interface UseNodeTypesResult {
  types: NodeTypeConfig[];
  loading: boolean;
  refresh: () => void;
}

export function useNodeTypes(): UseNodeTypesResult {
  const [types, setTypes] = useState<NodeTypeConfig[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback((): void => {
    getTypes()
      .then((data) => {
        setTypes(data);
      })
      .catch(() => {
        /* silent fail, can retry */
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { types, loading, refresh };
}
