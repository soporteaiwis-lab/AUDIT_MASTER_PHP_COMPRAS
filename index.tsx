import React, { useState, useEffect, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI } from "@google/genai";

// Declare global libraries loaded via CDN
declare const Papa: any;
declare const XLSX: any;
declare const ExcelJS: any;

// --- Types ---

type ParsedRow = Record<string, string>;

interface DataFile {
  name: string;
  data: ParsedRow[];
  headers: string[];
}

interface AnalysisResult {
  softlandTotal: number;
  controlTotal: number;
  missingCount: number;
  missingAmount: number;
  missingRecords: ParsedRow[];
  matchedCount: number;
}

interface SchoolConfig {
  id: string;
  name: string;
}

type AuditStatus = 'pending' | 'verified' | 'failed';

// --- Constants ---

const SCHOOLS: SchoolConfig[] = [
  { id: 'panguipulli', name: 'Colegio Panguipulli' },
  { id: 'pullinque', name: 'Colegio Pullinque' },
];

const REQUIRED_FIELDS = [
  { key: 'factura', label: 'N° Factura/Doc' },
  { key: 'rut', label: 'RUT' },
  { key: 'monto', label: 'Monto Total' },
  { key: 'nombre', label: 'Nombre/Proveedor' },
  { key: 'fecha', label: 'Fecha' }
];

// --- Helper Functions ---

const normalizeRut = (rut: string) => {
  if (!rut) return '';
  return rut.replace(/[.-]/g, '').toUpperCase().trim();
};

const normalizeInvoice = (inv: string) => {
  if (!inv) return '';
  return inv.trim().replace(/^0+/, ''); // Remove leading zeros
};

const parseAmount = (amt: string | number) => {
  if (typeof amt === 'number') return amt;
  if (!amt) return 0;
  const str = String(amt);
  const clean = str.replace(/[^0-9,.-]/g, '');
  const chileanFormat = clean.replace(/\./g, '');
  return parseInt(chileanFormat, 10) || 0;
};

// --- Reusable Table Component ---

const DataTable = ({ 
  data, 
  headers, 
  initialSearch = '', 
  title,
  enableAudit = false,
  onAuditAction,
  auditState,
  onDeepLink
}: { 
  data: ParsedRow[], 
  headers: string[], 
  initialSearch?: string, 
  title?: string,
  enableAudit?: boolean,
  onAuditAction?: (id: string, status: AuditStatus) => void,
  auditState?: Record<string, AuditStatus>,
  onDeepLink?: (target: 'softland' | 'control', query: string) => void
}) => {
  const [search, setSearch] = useState(initialSearch);
  const [sortConfig, setSortConfig] = useState<{ key: string, direction: 'asc' | 'desc' } | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 50;

  useEffect(() => {
    setSearch(initialSearch);
  }, [initialSearch]);

  const handleSort = (key: string) => {
    let direction: 'asc' | 'desc' = 'asc';
    if (sortConfig && sortConfig.key === key && sortConfig.direction === 'asc') {
      direction = 'desc';
    }
    setSortConfig({ key, direction });
  };

  const processedData = useMemo(() => {
    let result = [...data];

    // Filter
    if (search) {
      const lowerSearch = search.toLowerCase();
      result = result.filter(row => 
        Object.values(row).some(val => String(val).toLowerCase().includes(lowerSearch))
      );
    }

    // Sort
    if (sortConfig) {
      result.sort((a, b) => {
        const valA = a[sortConfig.key] || '';
        const valB = b[sortConfig.key] || '';
        
        // Try numeric sort for amounts
        const numA = parseAmount(valA);
        const numB = parseAmount(valB);
        
        if (!isNaN(numA) && !isNaN(numB) && (sortConfig.key.includes('monto') || sortConfig.key.includes('total'))) {
           return sortConfig.direction === 'asc' ? numA - numB : numB - numA;
        }

        if (valA < valB) return sortConfig.direction === 'asc' ? -1 : 1;
        if (valA > valB) return sortConfig.direction === 'asc' ? 1 : -1;
        return 0;
      });
    }

    return result;
  }, [data, search, sortConfig]);

  const totalPages = Math.ceil(processedData.length / itemsPerPage);
  const currentData = processedData.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);

  const copyToClipboard = () => {
    // Tab separated values for Excel/Sheets paste
    const headerRow = headers.join('\t');
    const rows = processedData.map(row => headers.map(h => row[h] || '').join('\t')).join('\n');
    navigator.clipboard.writeText(headerRow + '\n' + rows).then(() => {
      alert("Datos copiados al portapapeles. Ahora puedes pegar (Ctrl+V) directamente en Google Sheets.");
    });
  };

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 flex flex-col h-full">
      <div className="p-4 border-b border-gray-100 flex flex-col sm:flex-row justify-between items-center gap-4">
        <h3 className="font-semibold text-gray-800">{title} <span className="text-gray-500 text-sm font-normal">({processedData.length} registros)</span></h3>
        <div className="flex gap-2 w-full sm:w-auto">
           <input 
             type="text" 
             placeholder="Buscar en tabla..." 
             className="border rounded-md px-3 py-1.5 text-sm w-full sm:w-64"
             value={search}
             onChange={(e) => setSearch(e.target.value)}
           />
           <button 
             onClick={copyToClipboard}
             title="Copiar para pegar en Google Sheets"
             className="bg-green-100 text-green-700 px-3 py-1.5 rounded-md hover:bg-green-200 text-sm font-medium flex items-center gap-1 transition-colors"
           >
             <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2v1" /></svg>
             <span className="hidden sm:inline">Copiar</span>
           </button>
        </div>
      </div>

      <div className="overflow-auto flex-1">
        <table className="min-w-full divide-y divide-gray-200 relative">
          <thead className="bg-gray-50 sticky top-0 z-10 shadow-sm">
            <tr>
              {enableAudit && (
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider bg-gray-50">Auditoría</th>
              )}
              {headers.map(header => (
                <th 
                  key={header} 
                  className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100 select-none whitespace-nowrap"
                  onClick={() => handleSort(header)}
                >
                  <div className="flex items-center gap-1">
                    {header}
                    {sortConfig?.key === header && (
                      <span>{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {currentData.map((row, idx) => {
               // Unique Key generation
               const rowId = row['_key'] || `${idx}`; 
               const status = auditState?.[rowId] || 'pending';
               
               return (
                <tr key={idx} className={`hover:bg-gray-50 transition-colors ${status === 'verified' ? 'bg-green-50' : status === 'failed' ? 'bg-red-50' : ''}`}>
                  {enableAudit && onAuditAction && (
                    <td className="px-4 py-3 whitespace-nowrap text-sm flex items-center gap-2">
                      <button 
                        onClick={() => onAuditAction(rowId, 'verified')}
                        title="Marcar como Correcto (Faltante Confirmado)"
                        className={`p-1 rounded-full ${status === 'verified' ? 'bg-green-500 text-white' : 'text-gray-300 hover:text-green-500'}`}
                      >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                      </button>
                      <button 
                         onClick={() => onAuditAction(rowId, 'failed')}
                         title="Marcar como Fallido (Falso Positivo)"
                         className={`p-1 rounded-full ${status === 'failed' ? 'bg-red-500 text-white' : 'text-gray-300 hover:text-red-500'}`}
                      >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                      </button>
                    </td>
                  )}
                  {headers.map((header, hIdx) => {
                    const val = row[header];
                    const isInvoice = header === 'factura_val';
                    
                    return (
                      <td key={hIdx} className="px-4 py-3 whitespace-nowrap text-sm text-gray-700">
                        <div className="flex items-center gap-2">
                          {val}
                          {/* Cross Reference Buttons for Invoice Column in Audit Mode */}
                          {enableAudit && isInvoice && onDeepLink && (
                            <div className="flex opacity-20 group-hover:opacity-100 transition-opacity">
                              <button 
                                onClick={() => onDeepLink('softland', val)}
                                title="Buscar en Softland"
                                className="text-blue-500 hover:text-blue-700 p-1"
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                              </button>
                              <button 
                                onClick={() => onDeepLink('control', val)}
                                title="Buscar en Control (Verificar ausencia)"
                                className="text-purple-500 hover:text-purple-700 p-1"
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 012-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
                              </button>
                            </div>
                          )}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      
      {/* Pagination */}
      <div className="p-3 border-t border-gray-100 flex justify-between items-center text-sm text-gray-600">
        <span>Página {currentPage} de {totalPages}</span>
        <div className="flex gap-2">
          <button 
            disabled={currentPage === 1}
            onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
            className="px-3 py-1 border rounded hover:bg-gray-50 disabled:opacity-50"
          >
            Anterior
          </button>
          <button 
            disabled={currentPage === totalPages}
            onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
            className="px-3 py-1 border rounded hover:bg-gray-50 disabled:opacity-50"
          >
            Siguiente
          </button>
        </div>
      </div>
    </div>
  );
};

// --- Statistics Component ---

const MonthlyStats = ({ records }: { records: ParsedRow[] }) => {
  const stats = useMemo(() => {
    const grouped: Record<string, { count: number, total: number }> = {};
    
    records.forEach(r => {
      // Try to parse date. Assuming DD/MM/YYYY or YYYY-MM-DD
      const dateStr = r['fecha_val'] || '';
      let monthYear = 'Desconocido';
      
      // Simple parse logic for common Spanish formats
      const parts = dateStr.split(/[-/]/);
      if (parts.length === 3) {
        // Assume if first part > 12 it's DD, else check format. 
        // Standardizing to YYYY-MM based on typical DD-MM-YYYY
        if (parts[0].length === 4) {
           monthYear = `${parts[0]}-${parts[1]}`; // YYYY-MM
        } else {
           monthYear = `${parts[2]}-${parts[1]}`; // YYYY-MM
        }
      }

      if (!grouped[monthYear]) grouped[monthYear] = { count: 0, total: 0 };
      grouped[monthYear].count++;
      grouped[monthYear].total += parseAmount(r['monto_val']);
    });

    return Object.entries(grouped).sort((a,b) => a[0].localeCompare(b[0]));
  }, [records]);

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3 mb-6">
      {stats.map(([key, val]) => (
        <div key={key} className="bg-white p-3 rounded shadow-sm border border-slate-200">
          <div className="text-xs text-gray-500 font-bold uppercase">{key}</div>
          <div className="text-lg font-bold text-slate-800">{val.count} Reg.</div>
          <div className="text-xs text-red-600 font-medium">${val.total.toLocaleString('es-CL')}</div>
        </div>
      ))}
    </div>
  );
};

// --- File Components ---

const FileUploader = ({ 
  label, 
  onFileLoaded, 
  fileInfo 
}: { 
  label: string, 
  onFileLoaded: (f: DataFile) => void,
  fileInfo: DataFile | null
}) => {
  const [isDragOver, setIsDragOver] = useState(false);
  const [loading, setLoading] = useState(false);

  const processExcel = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: 'array' });
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        
        // Convert to JSON with raw values
        const jsonData: any[] = XLSX.utils.sheet_to_json(worksheet, { defval: "" });
        
        if (jsonData.length === 0) {
          alert("El archivo Excel parece estar vacío.");
          setLoading(false);
          return;
        }

        // Standardize: Convert all values to Strings
        const standardizedData: ParsedRow[] = jsonData.map(row => {
          const newRow: ParsedRow = {};
          Object.keys(row).forEach(key => {
            newRow[key] = String(row[key] !== undefined && row[key] !== null ? row[key] : "").trim();
          });
          return newRow;
        });

        const headers = Object.keys(jsonData[0]);

        onFileLoaded({
          name: file.name,
          data: standardizedData,
          headers: headers
        });
      } catch (err) {
        console.error("Error al procesar Excel", err);
        alert("Error al leer el archivo Excel.");
      } finally {
        setLoading(false);
      }
    };
    reader.readAsArrayBuffer(file);
  };

  const processCSV = (file: File) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results: any) => {
        onFileLoaded({
          name: file.name,
          data: results.data,
          headers: results.meta.fields || []
        });
        setLoading(false);
      }
    });
  };

  const handleFile = (file: File) => {
    setLoading(true);
    const ext = file.name.split('.').pop()?.toLowerCase();
    
    if (ext === 'xlsx' || ext === 'xls') {
      processExcel(file);
    } else {
      processCSV(file);
    }
  };

  return (
    <div 
      className={`border-2 border-dashed rounded-lg p-6 text-center transition-colors ${
        isDragOver ? 'border-blue-500 bg-blue-50' : 'border-gray-300 bg-white'
      } ${fileInfo ? 'border-green-500 bg-green-50' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragOver(false);
        if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
      }}
    >
      <div className="mb-2">
        {loading ? (
           <svg className="animate-spin h-10 w-10 mx-auto text-blue-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
             <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
             <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
           </svg>
        ) : (
          <svg className={`w-10 h-10 mx-auto ${fileInfo ? 'text-green-500' : 'text-gray-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
        )}
      </div>
      <h3 className="font-semibold text-gray-700">{label}</h3>
      {fileInfo ? (
        <p className="text-sm text-green-600 mt-1">Cargado: {fileInfo.name} ({fileInfo.data.length} filas)</p>
      ) : (
        <p className="text-sm text-gray-500 mt-1">Arrastra tu archivo (.csv o .xlsx)</p>
      )}
      <input 
        type="file" 
        accept=".csv,.xlsx,.xls"
        className="hidden" 
        onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
        id={`file-${label}`}
      />
      <label htmlFor={`file-${label}`} className="mt-2 inline-block text-xs text-blue-600 hover:text-blue-800 cursor-pointer">
        o buscar archivo
      </label>
    </div>
  );
};

const ColumnMapper = ({ 
  headers, 
  mapping, 
  setMapping 
}: { 
  headers: string[], 
  mapping: Record<string, string>, 
  setMapping: (m: Record<string, string>) => void 
}) => {
  // Auto-detect columns on first load
  useEffect(() => {
    const newMapping = { ...mapping };
    let changed = false;
    REQUIRED_FIELDS.forEach(field => {
      if (!newMapping[field.key]) {
        const match = headers.find(h => 
          h.toLowerCase().includes(field.key) || 
          h.toLowerCase().includes(field.label.toLowerCase().split('/')[0])
        );
        if (match) {
          newMapping[field.key] = match;
          changed = true;
        }
      }
    });
    if (changed) setMapping(newMapping);
  }, [headers]);

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 bg-gray-50 p-4 rounded-md">
      {REQUIRED_FIELDS.map(field => (
        <div key={field.key}>
          <label className="block text-xs font-medium text-gray-700 mb-1">{field.label}</label>
          <select 
            className="w-full text-sm border-gray-300 rounded-md shadow-sm focus:border-blue-500 focus:ring-blue-500"
            value={mapping[field.key] || ''}
            onChange={(e) => setMapping({...mapping, [field.key]: e.target.value})}
          >
            <option value="">-- Seleccionar Columna --</option>
            {headers.map(h => <option key={h} value={h}>{h}</option>)}
          </select>
        </div>
      ))}
    </div>
  );
};

const DiscrepancyReport = ({ 
  result, 
  schoolName, 
  auditState, 
  setAuditState,
  onDeepLink
}: { 
  result: AnalysisResult, 
  schoolName: string, 
  auditState: Record<string, AuditStatus>,
  setAuditState: (s: Record<string, AuditStatus>) => void,
  onDeepLink: (t: 'softland' | 'control', q: string) => void
}) => {
  const [aiReport, setAiReport] = useState<string>('');
  const [loadingAi, setLoadingAi] = useState(false);
  const [exporting, setExporting] = useState(false);

  const generateAiReport = async () => {
    setLoadingAi(true);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const topMissing = result.missingRecords
        .sort((a, b) => parseAmount(b['monto_val']) - parseAmount(a['monto_val']))
        .slice(0, 10);
      
      const prompt = `
        Actúa como un Auditor Financiero Senior. Analiza los siguientes resultados de una conciliación entre el sistema contable "Softland" (Maestro) y el "Control Presupuestario Manual" para la entidad "${schoolName}".
        
        Datos Generales:
        - Total registros en Softland: ${result.softlandTotal}
        - Total registros en Control: ${result.controlTotal}
        - Registros NO encontrados en Control (Faltantes): ${result.missingCount}
        - Monto Total Faltante (Discrepancia): $${result.missingAmount.toLocaleString('es-CL')}

        Muestra de los 10 registros faltantes más grandes (por monto):
        ${JSON.stringify(topMissing.map(r => ({
          Factura: r['factura_val'],
          Proveedor: r['nombre_val'],
          Monto: r['monto_val'],
          Fecha: r['fecha_val']
        })))}

        Por favor, redacta un "Informe Ejecutivo de Auditoría" en formato Markdown.
        1. Resumen de la situación: Indica claramente cuánto dinero está registrado en contabilidad pero no en el control manual.
        2. Análisis de riesgo: ¿Qué implica que estos registros no estén en el control?
        3. Detalle de hallazgos principales: Menciona los proveedores con mayores montos faltantes.
        4. Recomendaciones: Pasos a seguir para el equipo de administración.
      `;

      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: prompt,
      });

      setAiReport(response.text || 'No se pudo generar el reporte.');
    } catch (error) {
      console.error(error);
      setAiReport('Error al conectar con el servicio de IA. Verifique su conexión.');
    } finally {
      setLoadingAi(false);
    }
  };

  const exportToExcel = async () => {
    setExporting(true);
    try {
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('Discrepancias');

      worksheet.columns = [
        { header: 'Estado Auditoría', key: 'status', width: 15 },
        { header: 'Fecha', key: 'fecha', width: 15 },
        { header: 'N° Factura', key: 'factura', width: 20 },
        { header: 'RUT', key: 'rut', width: 15 },
        { header: 'Nombre / Proveedor', key: 'nombre', width: 40 },
        { header: 'Monto ($)', key: 'monto', width: 20 },
      ];

      result.missingRecords.forEach(row => {
        const status = auditState[row['_key']] || 'Pendiente';
        worksheet.addRow({
          status: status === 'verified' ? 'Confirmado' : status === 'failed' ? 'Descartado' : 'Pendiente',
          fecha: row['fecha_val'],
          factura: row['factura_val'],
          rut: row['rut_val'],
          nombre: row['nombre_val'],
          monto: parseInt(row['monto_val'])
        });
      });

      const headerRow = worksheet.getRow(1);
      headerRow.eachCell((cell: any) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
        cell.font = { color: { argb: 'FFFFFFFF' }, bold: true };
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
      });
      headerRow.height = 25;

      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `Reporte_Auditoria_${schoolName.replace(/\s+/g, '_')}_${new Date().toISOString().slice(0,10)}.xlsx`;
      link.click();
    } catch (error) {
      console.error("Error exporting Excel", error);
      alert("Hubo un error al generar el Excel.");
    } finally {
      setExporting(false);
    }
  };

  const handleAuditAction = (id: string, status: AuditStatus) => {
    setAuditState({ ...auditState, [id]: status });
  };

  return (
    <div className="space-y-6 animate-fade-in-up">
      <div className="flex flex-col sm:flex-row justify-between items-center gap-4 bg-white p-4 rounded-lg shadow-sm">
        <h3 className="text-lg font-medium text-gray-900">Módulo de Auditoría y Validación</h3>
        <div className="flex gap-2">
          <button 
            onClick={exportToExcel}
            className="flex items-center space-x-2 bg-emerald-600 text-white px-4 py-2 rounded-md hover:bg-emerald-700 text-sm font-medium transition"
          >
            {exporting ? <span>Exportando...</span> : <span>Exportar Excel</span>}
          </button>
          <button 
            onClick={generateAiReport}
            disabled={loadingAi}
            className="flex items-center space-x-2 bg-indigo-600 text-white px-4 py-2 rounded-md hover:bg-indigo-700 text-sm font-medium transition disabled:opacity-50"
          >
            {loadingAi ? <span>Analizando...</span> : <span>Informe IA</span>}
          </button>
        </div>
      </div>
        
      {aiReport && (
        <div className="p-6 bg-indigo-50 border border-indigo-100 rounded-lg">
          <h4 className="text-indigo-900 font-bold mb-2">Informe Ejecutivo IA</h4>
          <div className="prose prose-sm max-w-none text-indigo-900/80 whitespace-pre-wrap font-sans">
            {aiReport}
          </div>
        </div>
      )}

      {/* Statistics Section */}
      <h4 className="font-semibold text-gray-700 mt-6">Estadísticas por Mes (Faltantes)</h4>
      <MonthlyStats records={result.missingRecords} />

      {/* Main Data Table */}
      <div className="h-[600px]">
        <DataTable 
          data={result.missingRecords}
          headers={['fecha_val', 'factura_val', 'rut_val', 'nombre_val', 'monto_val']}
          title="Registro de Discrepancias"
          enableAudit={true}
          auditState={auditState}
          onAuditAction={handleAuditAction}
          onDeepLink={onDeepLink}
        />
      </div>
    </div>
  );
};

// --- Main App Component ---

const App = () => {
  const [selectedSchool, setSelectedSchool] = useState(SCHOOLS[0].id);
  const [softlandFile, setSoftlandFile] = useState<DataFile | null>(null);
  const [controlFile, setControlFile] = useState<DataFile | null>(null);
  const [softlandMapping, setSoftlandMapping] = useState<Record<string, string>>({});
  const [controlMapping, setControlMapping] = useState<Record<string, string>>({});
  
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  
  // Tab State
  const [activeTab, setActiveTab] = useState<'dashboard' | 'softland' | 'control'>('dashboard');
  
  // Shared Search State for Deep Linking
  const [softlandSearch, setSoftlandSearch] = useState('');
  const [controlSearch, setControlSearch] = useState('');

  // Audit State Persistence
  const [auditState, setAuditState] = useState<Record<string, AuditStatus>>({});

  const currentSchoolName = SCHOOLS.find(s => s.id === selectedSchool)?.name || '';

  useEffect(() => {
    // Reset analysis when school changes, but maybe we want to keep files? 
    // For safety, let's reset to avoid mixing data.
    setSoftlandFile(null);
    setControlFile(null);
    setAnalysis(null);
    setSoftlandMapping({});
    setControlMapping({});
    setAuditState({});
    setActiveTab('dashboard');
  }, [selectedSchool]);

  const runAnalysis = () => {
    if (!softlandFile || !controlFile) return;

    // Helper to extract clean values based on mapping
    const processRows = (rows: ParsedRow[], mapping: Record<string, string>) => {
      return rows.map((row, idx) => ({
        ...row,
        factura_val: row[mapping['factura']] || '',
        rut_val: row[mapping['rut']] || '',
        monto_val: parseAmount(row[mapping['monto']] || '0').toString(),
        nombre_val: row[mapping['nombre']] || '',
        fecha_val: row[mapping['fecha']] || '',
        _key: `${normalizeRut(row[mapping['rut']])}_${normalizeInvoice(row[mapping['factura']])}`
      })).filter(r => r.factura_val && r.monto_val !== '0');
    };

    const softlandProcessed = processRows(softlandFile.data, softlandMapping);
    const controlProcessed = processRows(controlFile.data, controlMapping);
    const controlKeys = new Set(controlProcessed.map(r => r._key));

    const missingRecords = softlandProcessed.filter(sRow => !controlKeys.has(sRow._key));
    const totalMissingAmount = missingRecords.reduce((sum, r) => sum + parseInt(r.monto_val), 0);

    setAnalysis({
      softlandTotal: softlandProcessed.length,
      controlTotal: controlProcessed.length,
      matchedCount: softlandProcessed.length - missingRecords.length,
      missingCount: missingRecords.length,
      missingAmount: totalMissingAmount,
      missingRecords: missingRecords
    });
  };

  const handleDeepLink = (target: 'softland' | 'control', query: string) => {
    if (target === 'softland') {
      setSoftlandSearch(query);
      setActiveTab('softland');
    } else {
      setControlSearch(query);
      setActiveTab('control');
    }
  };

  return (
    <div className="min-h-screen flex flex-col md:flex-row bg-slate-50">
      {/* Sidebar */}
      <aside className="w-full md:w-64 bg-slate-900 text-white flex-shrink-0 flex flex-col h-screen sticky top-0">
        <div className="p-6">
          <h1 className="text-xl font-bold text-slate-100 flex items-center gap-2">
             <svg className="w-6 h-6 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
             AuditMaster
          </h1>
          <p className="text-xs text-slate-400 mt-1">Conciliación Contable</p>
        </div>
        
        <nav className="mt-4 px-2 flex-1">
          <div className="mb-4">
            <p className="px-4 text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Entidad</p>
            {SCHOOLS.map(school => (
              <button
                key={school.id}
                onClick={() => setSelectedSchool(school.id)}
                className={`w-full text-left px-4 py-2 rounded-md mb-1 text-sm transition-colors ${
                  selectedSchool === school.id ? 'bg-blue-600 text-white shadow-md' : 'text-slate-300 hover:bg-slate-800'
                }`}
              >
                {school.name}
              </button>
            ))}
          </div>

          {analysis && (
            <div>
              <p className="px-4 text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Vistas</p>
              <button
                onClick={() => setActiveTab('dashboard')}
                className={`w-full text-left px-4 py-2 rounded-md mb-1 text-sm flex items-center gap-2 ${
                  activeTab === 'dashboard' ? 'bg-slate-800 text-white' : 'text-slate-300 hover:bg-slate-800'
                }`}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" /></svg>
                Resultados
              </button>
              <button
                onClick={() => setActiveTab('softland')}
                className={`w-full text-left px-4 py-2 rounded-md mb-1 text-sm flex items-center gap-2 ${
                  activeTab === 'softland' ? 'bg-slate-800 text-white' : 'text-slate-300 hover:bg-slate-800'
                }`}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" /></svg>
                Base Softland
              </button>
              <button
                onClick={() => setActiveTab('control')}
                className={`w-full text-left px-4 py-2 rounded-md mb-1 text-sm flex items-center gap-2 ${
                  activeTab === 'control' ? 'bg-slate-800 text-white' : 'text-slate-300 hover:bg-slate-800'
                }`}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 012-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
                Base Control
              </button>
            </div>
          )}
        </nav>
      </aside>

      {/* Main Content */}
      <main className="flex-1 p-8 overflow-y-auto max-h-screen">
        <div className="max-w-[1400px] mx-auto">
          <header className="mb-6">
             <h2 className="text-2xl font-bold text-gray-800">{currentSchoolName}</h2>
             <p className="text-gray-500">
               {analysis ? 'Panel de Auditoría Activo' : 'Cargue los archivos para comenzar'}
             </p>
          </header>

          {!analysis && (
            <>
              {/* Upload Section */}
              <section className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
                <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
                  <div className="flex items-center gap-2 mb-4">
                    <div className="w-3 h-3 rounded-full bg-blue-500"></div>
                    <h3 className="font-semibold text-gray-800">1. Maestro Softland</h3>
                  </div>
                  <FileUploader 
                    label="Cargar Softland" 
                    fileInfo={softlandFile} 
                    onFileLoaded={setSoftlandFile} 
                  />
                  {softlandFile && (
                    <div className="mt-4">
                      <h4 className="text-xs font-semibold text-gray-500 uppercase mb-2">Mapeo de Columnas</h4>
                      <ColumnMapper headers={softlandFile.headers} mapping={softlandMapping} setMapping={setSoftlandMapping} />
                    </div>
                  )}
                </div>

                <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
                  <div className="flex items-center gap-2 mb-4">
                    <div className="w-3 h-3 rounded-full bg-green-500"></div>
                    <h3 className="font-semibold text-gray-800">2. Control Presupuesto</h3>
                  </div>
                  <FileUploader 
                    label="Cargar Control" 
                    fileInfo={controlFile} 
                    onFileLoaded={setControlFile} 
                  />
                  {controlFile && (
                    <div className="mt-4">
                      <h4 className="text-xs font-semibold text-gray-500 uppercase mb-2">Mapeo de Columnas</h4>
                      <ColumnMapper headers={controlFile.headers} mapping={controlMapping} setMapping={setControlMapping} />
                    </div>
                  )}
                </div>
              </section>

              <div className="flex justify-center mb-8">
                <button
                  onClick={runAnalysis}
                  disabled={!softlandFile || !controlFile}
                  className="bg-slate-900 text-white px-8 py-3 rounded-lg font-semibold shadow-lg hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transform transition active:scale-95"
                >
                  Realizar Cruce de Información
                </button>
              </div>
            </>
          )}

          {analysis && activeTab === 'dashboard' && (
             <div className="space-y-6">
                {/* KPI Cards */}
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                  <div className="bg-white p-4 rounded-lg shadow-sm border border-gray-100">
                    <p className="text-xs text-gray-500 uppercase font-bold">Total Softland</p>
                    <p className="text-2xl font-bold text-blue-600">{analysis.softlandTotal}</p>
                  </div>
                  <div className="bg-white p-4 rounded-lg shadow-sm border border-gray-100">
                    <p className="text-xs text-gray-500 uppercase font-bold">Total Control</p>
                    <p className="text-2xl font-bold text-green-600">{analysis.controlTotal}</p>
                  </div>
                  <div className="bg-white p-4 rounded-lg shadow-sm border border-gray-100 bg-red-50">
                    <p className="text-xs text-red-500 uppercase font-bold">No Ingresados</p>
                    <p className="text-2xl font-bold text-red-600">{analysis.missingCount}</p>
                  </div>
                  <div className="bg-white p-4 rounded-lg shadow-sm border border-gray-100">
                    <p className="text-xs text-gray-500 uppercase font-bold">Monto Diferencia</p>
                    <p className="text-2xl font-bold text-slate-800">${analysis.missingAmount.toLocaleString('es-CL')}</p>
                  </div>
                </div>

                <DiscrepancyReport 
                  result={analysis} 
                  schoolName={currentSchoolName}
                  auditState={auditState}
                  setAuditState={setAuditState}
                  onDeepLink={handleDeepLink}
                />
             </div>
          )}

          {analysis && activeTab === 'softland' && softlandFile && (
            <div className="h-[calc(100vh-150px)] animate-fade-in-up">
               <DataTable 
                 data={softlandFile.data} 
                 headers={softlandFile.headers} 
                 title="Base de Datos Completa - Softland"
                 initialSearch={softlandSearch}
               />
            </div>
          )}

          {analysis && activeTab === 'control' && controlFile && (
            <div className="h-[calc(100vh-150px)] animate-fade-in-up">
               <DataTable 
                 data={controlFile.data} 
                 headers={controlFile.headers} 
                 title="Base de Datos Completa - Control Presupuestario"
                 initialSearch={controlSearch}
               />
            </div>
          )}

        </div>
      </main>
    </div>
  );
};

const root = createRoot(document.getElementById('root')!);
root.render(<App />);