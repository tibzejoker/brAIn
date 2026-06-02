import { useState, useEffect, useCallback } from "react";
import type { NodeTypeConfig } from "../api/types";
import { getTypes } from "../api/client";
import { onTypeChanged } from "../api/socket";

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
    // Live-refresh when the scanner (de)registers a dynamic type, so a
    // freshly-developed node shows up in the Node Creator without a reload.
    return onTypeChanged(() => { refresh(); });
  }, [refresh]);

  return { types, loading, refresh };
}
