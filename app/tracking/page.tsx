'use client';

import { useEffect, useState } from 'react';
import { Layers, MapPin, Plus, PowerOff, Tag } from 'lucide-react';
import {
  Button,
  Card,
  Input,
  Select,
  Label,
  Badge,
  Table,
  Th,
  Td,
  Tr,
  Modal,
  ConfirmDialog,
  EmptyState,
  Spinner,
  PageHeader,
  toast,
} from '@/components/ui';
import { api, ApiError } from '@/lib/client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ClassRow {
  id: string;
  name: string;
  parentId: string | null;
  isActive: boolean;
  createdAt: string;
}

interface LocationRow {
  id: string;
  name: string;
  isActive: boolean;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Classes Card
// ---------------------------------------------------------------------------

function ClassesCard() {
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [loading, setLoading] = useState(true);

  // Add modal
  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState('');
  const [addParentId, setAddParentId] = useState('');
  const [addSaving, setAddSaving] = useState(false);

  // Deactivate confirm
  const [deactivateTarget, setDeactivateTarget] = useState<ClassRow | null>(null);
  const [deactivating, setDeactivating] = useState(false);

  async function fetchClasses() {
    setLoading(true);
    try {
      const data = await api.get<ClassRow[]>('/api/classes');
      setClasses(data);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to load classes', 'danger');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchClasses();
  }, []);

  function openAddModal() {
    setAddName('');
    setAddParentId('');
    setAddOpen(true);
  }

  async function handleAdd() {
    if (!addName.trim()) {
      toast('Name is required', 'danger');
      return;
    }
    setAddSaving(true);
    try {
      await api.post('/api/classes', {
        name: addName.trim(),
        parentId: addParentId || null,
      });
      toast('Class created', 'success');
      setAddOpen(false);
      await fetchClasses();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to create class', 'danger');
    } finally {
      setAddSaving(false);
    }
  }

  async function handleDeactivate() {
    if (!deactivateTarget) return;
    setDeactivating(true);
    try {
      await api.patch(`/api/classes/${deactivateTarget.id}`, {});
      toast(`"${deactivateTarget.name}" deactivated`, 'success');
      setDeactivateTarget(null);
      await fetchClasses();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to deactivate', 'danger');
    } finally {
      setDeactivating(false);
    }
  }

  const parentName = (id: string | null) =>
    id ? (classes.find((c) => c.id === id)?.name ?? null) : '-';

  return (
    <>
      <Card className="flex-1 min-w-0 p-6 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-navy">
            <Layers className="h-5 w-5 text-electric" />
            <h2 className="text-lg font-bold">Classes</h2>
          </div>
          <Button size="sm" onClick={openAddModal}>
            <Plus className="h-3.5 w-3.5" />
            Add Class
          </Button>
        </div>

        {loading ? (
          <div className="py-8 flex justify-center text-electric">
            <Spinner className="h-6 w-6" />
          </div>
        ) : classes.length === 0 ? (
          <EmptyState
            icon={Layers}
            title="No classes yet"
            message="Add a class to tag transactions for reporting."
            action={
              <Button onClick={openAddModal}>
                <Plus className="h-4 w-4" /> Add Class
              </Button>
            }
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Parent</Th>
                <Th>Status</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {classes.map((c) => (
                <Tr key={c.id}>
                  <Td className="font-medium text-navy">{c.name}</Td>
                  <Td className="text-navy/60">
                    {parentName(c.parentId) ?? (
                      <span className="text-navy/40 italic">Unknown parent</span>
                    )}
                  </Td>
                  <Td>
                    <Badge tone={c.isActive ? 'success' : 'neutral'}>
                      {c.isActive ? 'Active' : 'Inactive'}
                    </Badge>
                  </Td>
                  <Td className="text-right">
                    {c.isActive && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-red-500 hover:bg-red-50"
                        onClick={() => setDeactivateTarget(c)}
                        title="Deactivate class"
                      >
                        <PowerOff className="h-3.5 w-3.5" />
                        Deactivate
                      </Button>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {/* Add class modal */}
      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add Class"
        footer={
          <>
            <Button variant="secondary" onClick={() => setAddOpen(false)} disabled={addSaving}>
              Cancel
            </Button>
            <Button onClick={handleAdd} loading={addSaving}>
              Create Class
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div>
            <Label htmlFor="className">Name *</Label>
            <Input
              id="className"
              placeholder="e.g. Marketing"
              value={addName}
              onChange={(e) => setAddName(e.target.value)}
              autoFocus
            />
          </div>
          <div>
            <Label htmlFor="classParent">Parent Class (optional)</Label>
            <Select
              id="classParent"
              value={addParentId}
              onChange={(e) => setAddParentId(e.target.value)}
            >
              <option value="">-- None (top-level) --</option>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>
        </div>
      </Modal>

      {/* Deactivate confirm modal */}
      <ConfirmDialog
        open={!!deactivateTarget}
        title="Deactivate Class"
        message={
          <>
            Are you sure you want to deactivate{' '}
            <strong className="text-navy">{deactivateTarget?.name}</strong>? It will no longer
            appear in active lists but historical transactions will be preserved.
          </>
        }
        confirmLabel="Yes, Deactivate"
        tone="danger"
        loading={deactivating}
        onConfirm={handleDeactivate}
        onClose={() => setDeactivateTarget(null)}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Locations Card
// ---------------------------------------------------------------------------

function LocationsCard() {
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [loading, setLoading] = useState(true);

  // Add modal
  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState('');
  const [addSaving, setAddSaving] = useState(false);

  // Deactivate confirm
  const [deactivateTarget, setDeactivateTarget] = useState<LocationRow | null>(null);
  const [deactivating, setDeactivating] = useState(false);

  async function fetchLocations() {
    setLoading(true);
    try {
      const data = await api.get<LocationRow[]>('/api/locations');
      setLocations(data);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to load locations', 'danger');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchLocations();
  }, []);

  function openAddModal() {
    setAddName('');
    setAddOpen(true);
  }

  async function handleAdd() {
    if (!addName.trim()) {
      toast('Name is required', 'danger');
      return;
    }
    setAddSaving(true);
    try {
      await api.post('/api/locations', { name: addName.trim() });
      toast('Location created', 'success');
      setAddOpen(false);
      await fetchLocations();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to create location', 'danger');
    } finally {
      setAddSaving(false);
    }
  }

  async function handleDeactivate() {
    if (!deactivateTarget) return;
    setDeactivating(true);
    try {
      await api.patch(`/api/locations/${deactivateTarget.id}`, {});
      toast(`"${deactivateTarget.name}" deactivated`, 'success');
      setDeactivateTarget(null);
      await fetchLocations();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to deactivate', 'danger');
    } finally {
      setDeactivating(false);
    }
  }

  return (
    <>
      <Card className="flex-1 min-w-0 p-6 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-navy">
            <MapPin className="h-5 w-5 text-electric" />
            <h2 className="text-lg font-bold">Locations</h2>
          </div>
          <Button size="sm" onClick={openAddModal}>
            <Plus className="h-3.5 w-3.5" />
            Add Location
          </Button>
        </div>

        {loading ? (
          <div className="py-8 flex justify-center text-electric">
            <Spinner className="h-6 w-6" />
          </div>
        ) : locations.length === 0 ? (
          <EmptyState
            icon={MapPin}
            title="No locations yet"
            message="Add a location to tag transactions for reporting."
            action={
              <Button onClick={openAddModal}>
                <Plus className="h-4 w-4" /> Add Location
              </Button>
            }
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Status</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {locations.map((loc) => (
                <Tr key={loc.id}>
                  <Td className="font-medium text-navy">{loc.name}</Td>
                  <Td>
                    <Badge tone={loc.isActive ? 'success' : 'neutral'}>
                      {loc.isActive ? 'Active' : 'Inactive'}
                    </Badge>
                  </Td>
                  <Td className="text-right">
                    {loc.isActive && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-red-500 hover:bg-red-50"
                        onClick={() => setDeactivateTarget(loc)}
                        title="Deactivate location"
                      >
                        <PowerOff className="h-3.5 w-3.5" />
                        Deactivate
                      </Button>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {/* Add location modal */}
      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add Location"
        footer={
          <>
            <Button variant="secondary" onClick={() => setAddOpen(false)} disabled={addSaving}>
              Cancel
            </Button>
            <Button onClick={handleAdd} loading={addSaving}>
              Create Location
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div>
            <Label htmlFor="locationName">Name *</Label>
            <Input
              id="locationName"
              placeholder="e.g. HQ, East Office"
              value={addName}
              onChange={(e) => setAddName(e.target.value)}
              autoFocus
            />
          </div>
        </div>
      </Modal>

      {/* Deactivate confirm modal */}
      <ConfirmDialog
        open={!!deactivateTarget}
        title="Deactivate Location"
        message={
          <>
            Are you sure you want to deactivate{' '}
            <strong className="text-navy">{deactivateTarget?.name}</strong>? It will no longer
            appear in active lists but historical transactions will be preserved.
          </>
        }
        confirmLabel="Yes, Deactivate"
        tone="danger"
        loading={deactivating}
        onConfirm={handleDeactivate}
        onClose={() => setDeactivateTarget(null)}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function TrackingPage() {
  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader title="Tracking Dimensions" icon={Tag} />

      <p className="text-navy/60 text-sm mb-6 max-w-2xl">
        Classes and Locations let you tag transactions for multi-dimensional reporting — similar to
        QuickBooks class and location tracking. They do not affect the GL balances.
      </p>

      <div className="flex flex-col lg:flex-row gap-6 items-start">
        <ClassesCard />
        <LocationsCard />
      </div>
    </main>
  );
}
