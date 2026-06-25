import { useState, useEffect, useCallback } from 'react';
import { fetchLibrary, deleteLibraryItem } from '../services/libraryApi';

export function useLibrary() {
  const [items, setItems]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchLibrary();
      setItems(data.items ?? []);
    } catch (err) {
      setError(err.message ?? 'Failed to load library');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const deleteItem = useCallback(async (id) => {
    try {
      await deleteLibraryItem(id);
      setItems(prev => prev.filter(item => item.id !== id));
    } catch (err) {
      setError(err.message ?? 'Failed to delete item');
    }
  }, []);

  return { items, loading, error, deleteItem, reload: load };
}
