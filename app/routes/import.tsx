import { useActionMutation, useActionQuery } from "@agent-native/core/client";
import { useQueryClient } from "@tanstack/react-query";
import {
  IconBriefcase,
  IconFileText,
  IconLock,
  IconUpload,
  IconUser,
  IconX,
} from "@tabler/icons-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { useSetPageTitle } from "@/components/layout/HeaderActions";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { APP_TITLE } from "@/lib/app-config";
import { cn } from "@/lib/utils";

export function meta() {
  return [{ title: `Import - ${APP_TITLE}` }];
}

// Keep in sync with actions/import-rm-csv.ts MAX_CSV_BYTES.
const MAX_CSV_BYTES = 15 * 1024 * 1024;

interface ImportSummary {
  ok: true;
  dryRun: boolean;
  rowsParsed: number;
  skippedInvalidRows: number;
  accountsCreated: string[];
  categoriesCreated: string[];
  imported: number;
  duplicatesSkipped: number;
  elapsedMs: number;
  profile: string;
  source: string;
  reason: string | null;
}

interface SelectedFile {
  name: string;
  size: number;
  text: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function ImportRoute() {
  useSetPageTitle("Import");
  const queryClient = useQueryClient();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<SelectedFile | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [profile, setProfile] = useState<"personal" | "business" | null>(null);
  const [preview, setPreview] = useState<ImportSummary | null>(null);
  const [importResult, setImportResult] = useState<ImportSummary | null>(null);

  const activeProfileQuery = useActionQuery("get-active-profile", {});
  const selectedProfile = profile ?? activeProfileQuery.data?.profile ?? "personal";

  const previewMutation = useActionMutation("import-rm-csv");
  const importMutation = useActionMutation("import-rm-csv");

  const isBusy = previewMutation.isPending || importMutation.isPending;

  function resetResults() {
    setPreview(null);
    setImportResult(null);
  }

  async function ingestFile(picked: File) {
    if (!picked.name.toLowerCase().endsWith(".csv")) {
      toast.error("Please choose a .csv file.");
      return;
    }
    if (picked.size > MAX_CSV_BYTES) {
      toast.error(`File is too large (max ${Math.round(MAX_CSV_BYTES / (1024 * 1024))}MB).`);
      return;
    }
    let text: string;
    try {
      text = await picked.text();
    } catch {
      toast.error("Could not read that file. Try choosing it again.");
      return;
    }
    if (text.trim().length === 0) {
      toast.error("That file is empty.");
      return;
    }
    resetResults();
    setFile({ name: picked.name, size: picked.size, text });
  }

  function handleDrop(e: React.DragEvent<HTMLElement>) {
    e.preventDefault();
    setDragActive(false);
    const dropped = e.dataTransfer.files?.[0];
    if (dropped) void ingestFile(dropped);
  }

  function clearFile() {
    setFile(null);
    resetResults();
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function handlePreview() {
    if (!file) {
      toast.error("Choose a CSV file first.");
      return;
    }
    setImportResult(null);
    previewMutation.mutate(
      { csvText: file.text, fileName: file.name, profile: selectedProfile, dryRun: true },
      {
        onSuccess: (result) => setPreview(result as ImportSummary),
        onError: (err) => toast.error(err instanceof Error ? err.message : "Preview failed."),
      },
    );
  }

  function handleImport() {
    if (!file) return;
    importMutation.mutate(
      { csvText: file.text, fileName: file.name, profile: selectedProfile, dryRun: false },
      {
        onSuccess: (result) => {
          const summary = result as ImportSummary;
          setImportResult(summary);
          queryClient.invalidateQueries({ queryKey: ["action"] });
          if (summary.imported === 0 && summary.reason) {
            toast.warning(summary.reason);
          } else {
            toast.success(
              `Imported ${summary.imported} transaction${summary.imported === 1 ? "" : "s"} in ${(summary.elapsedMs / 1000).toFixed(1)}s.`,
            );
          }
        },
        onError: (err) => toast.error(err instanceof Error ? err.message : "Import failed."),
      },
    );
  }

  const canImport =
    !isBusy &&
    !!file &&
    !!preview &&
    !importResult &&
    preview.source === file.name &&
    preview.profile === selectedProfile;

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 p-4 lg:p-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Import transaction history</h1>
        <p className="text-sm text-muted-foreground">
          Export your history from Rocket Money as a CSV, then drop it here. The file is read in
          your browser and its contents are sent to Finance to import.
        </p>
      </div>

      <Card className="rounded-2xl shadow-sm">
        <CardHeader>
          <CardTitle className="text-base">1. Choose a profile</CardTitle>
          <CardDescription>Which profile should these transactions belong to?</CardDescription>
        </CardHeader>
        <CardContent>
          <ToggleGroup
            type="single"
            value={selectedProfile}
            onValueChange={(value) => {
              if (value) {
                setProfile(value as "personal" | "business");
                resetResults();
              }
            }}
            className="gap-0 rounded-full border border-border bg-muted/40 p-0.5 w-fit"
            aria-label="Profile for this import"
          >
            <ToggleGroupItem
              value="personal"
              size="sm"
              className="gap-1.5 rounded-full px-3 text-xs data-[state=on]:bg-background data-[state=on]:shadow-sm"
            >
              <IconUser className="size-3.5" />
              Personal
            </ToggleGroupItem>
            <ToggleGroupItem
              value="business"
              size="sm"
              className="gap-1.5 rounded-full px-3 text-xs data-[state=on]:bg-background data-[state=on]:shadow-sm"
            >
              <IconBriefcase className="size-3.5" />
              Business
            </ToggleGroupItem>
          </ToggleGroup>
        </CardContent>
      </Card>

      <Card className="rounded-2xl shadow-sm">
        <CardHeader>
          <CardTitle className="text-base">2. Upload the CSV</CardTitle>
          <CardDescription>Drag a Rocket Money export here, or click to browse.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const picked = e.target.files?.[0];
              if (picked) void ingestFile(picked);
            }}
          />

          {file ? (
            <div className="flex items-center gap-3 rounded-xl border border-border bg-muted/30 p-3">
              <IconFileText className="size-8 shrink-0 text-primary" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{file.name}</p>
                <p className="text-xs text-muted-foreground">{formatBytes(file.size)}</p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 shrink-0"
                onClick={clearFile}
                disabled={isBusy}
                aria-label="Remove file"
              >
                <IconX className="size-4" />
              </Button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragActive(true);
              }}
              onDragLeave={(e) => {
                e.preventDefault();
                setDragActive(false);
              }}
              onDrop={handleDrop}
              className={cn(
                "flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-8 text-center transition-colors",
                dragActive
                  ? "border-primary bg-accent/60"
                  : "border-border hover:border-primary/50 hover:bg-accent/30",
              )}
            >
              <IconUpload className="size-8 text-muted-foreground" />
              <span className="text-sm font-medium">Drop your Rocket Money CSV here</span>
              <span className="text-xs text-muted-foreground">or click to browse (.csv)</span>
            </button>
          )}

          <div className="flex gap-2">
            <Button variant="outline" disabled={isBusy || !file} onClick={handlePreview}>
              {previewMutation.isPending ? "Previewing..." : "Preview"}
            </Button>
            <Button disabled={!canImport} onClick={handleImport}>
              <IconUpload className="size-4" />
              {importMutation.isPending ? "Importing..." : "Import"}
            </Button>
          </div>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <IconLock className="size-3.5" />
            Preview before every import to review exactly what will change.
          </p>
        </CardContent>
      </Card>

      {preview && !importResult ? (
        <Card className="rounded-2xl shadow-sm">
          <CardHeader>
            <CardTitle className="text-base">Preview</CardTitle>
            <CardDescription>Dry run — nothing was written yet.</CardDescription>
          </CardHeader>
          <CardContent>
            <SummaryTable summary={preview} />
          </CardContent>
        </Card>
      ) : null}

      {importResult ? (
        <Card
          className={cn(
            "rounded-2xl shadow-sm",
            importResult.imported > 0 ? "border-fin-positive/40" : "border-amber-500/40",
          )}
        >
          <CardHeader>
            <CardTitle className="text-base">
              {importResult.imported > 0 ? "Import complete" : "Nothing imported"}
            </CardTitle>
            <CardDescription>
              {importResult.imported > 0 ? (
                <>
                  {importResult.imported} transaction{importResult.imported === 1 ? "" : "s"} imported
                  in {(importResult.elapsedMs / 1000).toFixed(1)}s.
                </>
              ) : (
                (importResult.reason ?? "No new transactions were imported.")
              )}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <SummaryTable summary={importResult} />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function SummaryTable({ summary }: { summary: ImportSummary }) {
  return (
    <div className="space-y-3">
      {summary.reason && summary.dryRun ? (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-amber-700 dark:text-amber-400">
          {summary.reason}
        </p>
      ) : null}
      <Table>
        <TableBody>
          <TableRow>
            <TableCell className="text-muted-foreground">Rows parsed</TableCell>
            <TableCell className="text-right tabular-nums">{summary.rowsParsed}</TableCell>
          </TableRow>
          {summary.skippedInvalidRows > 0 ? (
            <TableRow>
              <TableCell className="text-muted-foreground">Skipped (invalid rows)</TableCell>
              <TableCell className="text-right tabular-nums">{summary.skippedInvalidRows}</TableCell>
            </TableRow>
          ) : null}
          <TableRow>
            <TableCell className="text-muted-foreground">
              {summary.dryRun ? "Accounts to create" : "Accounts created"}
            </TableCell>
            <TableCell className="text-right tabular-nums">{summary.accountsCreated.length}</TableCell>
          </TableRow>
          <TableRow>
            <TableCell className="text-muted-foreground">
              {summary.dryRun ? "Categories to create" : "Categories created"}
            </TableCell>
            <TableCell className="text-right tabular-nums">{summary.categoriesCreated.length}</TableCell>
          </TableRow>
          <TableRow>
            <TableCell className="text-muted-foreground">Duplicates skipped</TableCell>
            <TableCell className="text-right tabular-nums">{summary.duplicatesSkipped}</TableCell>
          </TableRow>
          <TableRow>
            <TableCell className="font-medium">
              {summary.dryRun ? "Importable" : "Imported"}
            </TableCell>
            <TableCell className="text-right font-semibold tabular-nums">
              {summary.dryRun ? summary.rowsParsed - summary.duplicatesSkipped : summary.imported}
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>

      {summary.accountsCreated.length > 0 ? (
        <div>
          <Separator className="mb-2" />
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Accounts
          </p>
          <ul className="space-y-0.5 text-sm">
            {summary.accountsCreated.map((name) => (
              <li key={name} className="text-muted-foreground">
                {name}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {summary.categoriesCreated.length > 0 ? (
        <div>
          <Separator className="mb-2" />
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Categories
          </p>
          <p className="text-sm text-muted-foreground">{summary.categoriesCreated.join(", ")}</p>
        </div>
      ) : null}
    </div>
  );
}
