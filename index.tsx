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
  controlRecords: ParsedRow[];
  softlandRecords: ParsedRow[];
}

interface SchoolConfig {
  id: string;
  name: string;
}

type AuditStatus = 'pending' | 'verified' | 'failed';

interface SchoolState {
  softlandFile: DataFile | null;
  controlFile: DataFile | null;
  softlandMapping: Record<string, string>;
  controlMapping: Record<string, string>;
  analysis: AnalysisResult | null;
  auditState: Record<string, AuditStatus>;
  softlandSearch: string;
  controlSearch: string;
  activeTab: 'dashboard' | 'softland' | 'control';
}

// --- Constants ---

const SCHOOLS: SchoolConfig[] = [
  { id: 'panguipulli', name: 'Colegio Panguipulli' },
  { id: 'pullinque', name: 'Colegio Pullinque' },
];

const INITIAL_SCHOOL_STATE: SchoolState = {
  softlandFile: null,
  controlFile: null,
  softlandMapping: {},
  controlMapping: {},
  analysis: null,
  auditState: {},
  softlandSearch: '',
  controlSearch: '',
  activeTab: 'dashboard'
};

// Keywords to detect the real header row in Softland/Control excels
const HEADER_KEYWORDS = ['fecha', 'factura', 'documento', 'numero', 'rut', 'proveedor', 'monto', 'total', 'debe', 'haber', 'tipo'];

const REQUIRED_FIELDS = [
  { key: 'factura', label: 'N° Factura/Doc' },
  { key: 'rut', label: 'RUT' },
  { key: 'monto', label: 'Monto Total' },
  { key: 'nombre', label: 'Nombre/Proveedor' },
  { key: 'fecha', label: 'Fecha' },
  { key: 'tipo', label: 'Tipo Docto (Ej: 33, 61, Factura)' }
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
  // Remove currency symbols and standard separators, keep minus sign
  const clean = str.replace(/[^0-9,.-]/g, '');
  // Assuming Chilean format: 1.000.000 or 1000000
  const chileanFormat = clean.replace(/\./g, ''); 
  return parseInt(chileanFormat, 10) || 0;
};

// ============================================================
// NUEVA FUNCIÓN DE VALIDACIÓN ROBUSTA
// ============================================================
const isValidDataRow = (row: ParsedRow, mapping: Record<string, string>): boolean => {
  // Obtener valores clave
  const factura = String(row[mapping['factura']] || '').trim();
  const rut = String(row[mapping['rut']] || '').trim();
  const monto = String(row[mapping['monto']] || '').trim();
  const nombre = String(row[mapping['nombre']] || '').trim().toLowerCase();
  const tipo = String(row[mapping['tipo']] || '').trim().toLowerCase();
  
  // === 1. VALIDACIONES BÁSICAS ===
  
  // 1.1 Factura debe existir y no ser 0
  if (!factura || factura === '0' || factura === 'nan' || factura === 'null') {
    return false;
  }
  
  // 1.2 RUT debe existir y tener formato válido (al menos 7 caracteres sin puntos/guiones)
  const rutClean = normalizeRut(rut);
  if (!rutClean || rutClean.length < 7) {
    return false;
  }
  
  // 1.3 Monto debe existir y no ser 0
  if (!monto || monto === '0' || monto === 'nan' || monto === 'null') {
    return false;
  }
  
  // 1.4 Nombre del proveedor debe existir
  if (!nombre || nombre === 'nan' || nombre === 'null') {
    return false;
  }
  
  // === 2. FILTRAR FILAS DE SUBTOTALES Y TÍTULOS ===
  
  // 2.1 Palabras clave que indican subtotales o títulos
  const invalidKeywords = [
    'total', 
    'subtotal', 
    'suma', 
    'libro de compra',
    'ordenado',
    'desde:',
    'hasta:',
    'moneda:',
    'período',
    'periodo',
    'resumen'
  ];
  
  if (invalidKeywords.some(kw => nombre.includes(kw))) {
    return false;
  }
  
  // 2.2 Si el nombre del proveedor es suspiciosamente corto (menos de 3 caracteres)
  if (nombre.length < 3) {
    return false;
  }
  
  // === 3. FILTRAR NOTAS DE CRÉDITO Y DOCUMENTOS NO VÁLIDOS ===
  
  // 3.1 Tipos de documento a excluir
  const tipoClean = tipo.replace('.0', '').replace(/\s+/g, '');
  const invalidTypes = [
    '61',  // Nota de crédito electrónica
    '56',  // Nota de débito
    '52',  // Guía de despacho
    '60',  // Nota de crédito manual
    'nc',
    'n/c',
    'notacredito',
    'notadebito',
    'credito',
    'debito',
    'débito',
    'crédito'
  ];
  
  if (invalidTypes.some(t => tipoClean === t || tipoClean.includes(t))) {
    return false;
  }
  
  // 3.2 Si el nombre contiene "nota de crédito" o similar
  if (nombre.includes('nota') && (nombre.includes('credito') || nombre.includes('crédito'))) {
    return false;
  }
  
  // === 4. FILTRAR MONTOS NEGATIVOS (GENERALMENTE NOTAS DE CRÉDITO) ===
  
  const montoNumerico = parseAmount(monto);
  if (montoNumerico < 0) {
    return false; // Las notas de crédito tienen montos negativos
  }
  
  // === 5. VALIDAR QUE EL RUT TENGA FORMATO CHILENO VÁLIDO ===
  
  // RUT debe tener entre 7 y 9 dígitos (sin considerar DV)
  const rutSinDV = rutClean.slice(0, -1);
  if (rutSinDV.length < 7 || rutSinDV.length > 9) {
    return false;
  }
  
  // Todos los caracteres del RUT (excepto el DV) deben ser dígitos
  if (!/^\d+$/.test(rutSinDV)) {
    return false;
  }
  
  // El dígito verificador debe ser dígito o K
  const dv = rutClean.slice(-1);
  if (!/^[0-9K]$/.test(dv)) {
    return false;
  }
  
  // Si pasó todas las validaciones, es una fila válida
  return true;
};
// ============================================================
// FIN DE FUNCIÓN DE VALIDACIÓN
// ============================================================

// --- Components ---

// 1. Comparison Modal
const ComparisonModal = ({ 
  record, 
  controlData, 
  onClose,
  onMarkStatus
}: { 
  record: ParsedRow, 
  controlData: ParsedRow[], 
  onClose: () => void,
  onMarkStatus: (status: AuditStatus) => void
}) => {
  const targetInv = normalizeInvoice(record['factura_val']);
  const candidate = controlData.find(c => normalizeInvoice(c['factura_val']) === targetInv);

  const fields = [
    { label: 'N° Factura', key: 'factura_val' },
    { label: 'RUT', key: 'rut_val' },
    { label: 'Monto', key: 'monto_val' },
    { label: 'Nombre', key: 'nombre_val' },
    { label: 'Fecha', key: 'fecha_val' }
  ];

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-5xl max-h-[90vh] overflow-y-auto flex flex-col">
        <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-slate-50 rounded-t-xl">
          <h3 className="text-xl font-bold text-gray-800">Análisis Detallado de Discrepancia</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="p-6 flex-1 overflow-y-auto">
          {candidate ? (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="border rounded-lg p-4 bg-blue-50/50 border-blue-100">
                <div className="flex items-center gap-2 mb-4">
                   <div className="w-3 h-3 rounded-full bg-blue-500"></div>
                   <h4 className="font-bold text-blue-900">Origen: Softland</h4>
                </div>
                <div className="space-y-3">
                  {fields.map(f => (
                    <div key={f.key}>
                      <span className="text-xs text-blue-400 uppercase font-semibold">{f.label}</span>
                      <div className="text-sm font-medium text-gray-800 break-words">{record[f.key]}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="border rounded-lg p-4 bg-gray-50 border-gray-200">
                 <div className="flex items-center gap-2 mb-4">
                   <div className="w-3 h-3 rounded-full bg-amber-500"></div>
                   <h4 className="font-bold text-gray-800">Diferencias Detectadas</h4>
                </div>
                <div className="space-y-3">
                   {fields.map(f => {
                     const valA = record[f.key];
                     const valB = candidate[f.key];
                     let match = valA === valB;
                     if (f.key === 'rut_val') match = normalizeRut(valA) === normalizeRut(valB);
                     if (f.key === 'monto_val') match = parseAmount(valA) === parseAmount(valB);
                     if (f.key === 'factura_val') match = normalizeInvoice(valA) === normalizeInvoice(valB);

                     return (
                       <div key={f.key} className="min-h-[3.5rem] flex items-center">
                         {match ? (
                           <span className="flex items-center text-green-600 text-sm bg-green-50 px-2 py-1 rounded-full">
                             <svg className="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                             Coincide
                           </span>
                         ) : (
                           <span className="flex items-center text-red-600 text-sm bg-red-50 px-2 py-1 rounded-full w-full">
                             <svg className="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                             Diferente
                           </span>
                         )}
                       </div>
                     );
                   })}
                </div>
              </div>

              <div className="border rounded-lg p-4 bg-green-50/50 border-green-100">
                 <div className="flex items-center gap-2 mb-4">
                   <div className="w-3 h-3 rounded-full bg-green-600"></div>
                   <h4 className="font-bold text-green-900">Destino: Control</h4>
                </div>
                <div className="space-y-3">
                  {fields.map(f => (
                    <div key={f.key}>
                      <span className="text-xs text-green-400 uppercase font-semibold">{f.label}</span>
                      <div className="text-sm font-medium text-gray-800 break-words">{candidate[f.key]}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="text-center py-12">
               <svg className="w-20 h-20 mx-auto text-gray-300 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
               <h4 className="text-xl font-bold text-gray-700 mb-2">No se encontró registro en Control</h4>
               <p className="text-gray-500 max-w-md mx-auto">Esta factura existe en Softland pero no se encontró un registro coincidente en la base de Control Presupuestario.</p>
               <div className="mt-6 bg-slate-50 border border-slate-200 p-4 rounded-lg max-w-md mx-auto text-left">
                  <p className="text-xs text-slate-600 font-bold uppercase mb-2">Dato de Softland</p>
                  {fields.map(f => (
                    <div key={f.key} className="py-1.5 border-b border-slate-100 last:border-0">
                      <span className="text-xs text-slate-500 font-semibold">{f.label}:</span>
                      <span className="text-sm ml-2 text-slate-800">{record[f.key]}</span>
                    </div>
                  ))}
               </div>
            </div>
          )}
        </div>

        <div className="p-6 border-t border-gray-100 flex justify-end gap-3 bg-slate-50 rounded-b-xl">
          <button 
            onClick={() => { onMarkStatus('verified'); onClose(); }}
            className="px-6 py-2 bg-slate-800 text-white rounded-lg hover:bg-slate-900 flex items-center gap-2 shadow-lg shadow-slate-200"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            Confirmar como Faltante
          </button>
          
          {candidate && (
            <button 
              onClick={() => { onMarkStatus('failed'); onClose(); }}
              className="px-6 py-2 bg-white border border-red-200 text-red-600 rounded-lg hover:bg-red-50 flex items-center gap-2"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
              Marcar Falso Positivo
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

const DataTable = ({ 
  data, 
  headers, 
  initialSearch = '', 
  title,
  enableAudit = false,
  onAuditAction,
  auditState,
  onSmartCheck,
  onAutoSmartCheck
}: { 
  data: ParsedRow[], 
  headers: string[], 
  initialSearch?: string, 
  title?: string,
  enableAudit?: boolean,
  onAuditAction?: (ids: string[], status: AuditStatus) => void,
  auditState?: Record<string, AuditStatus>,
  onSmartCheck?: (row: ParsedRow) => void,
  onAutoSmartCheck?: (ids: string[]) => void
}) => {
  const [search, setSearch] = useState(initialSearch);
  const [sortConfig, setSortConfig] = useState<{ key: string, direction: 'asc' | 'desc' } | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  const itemsPerPage = 50;

  useEffect(() => { setSearch(initialSearch); }, [initialSearch]);

  const handleSort = (key: string) => {
    let direction: 'asc' | 'desc' = 'asc';
    if (sortConfig && sortConfig.key === key && sortConfig.direction === 'asc') direction = 'desc';
    setSortConfig({ key, direction });
  };

  const processedData = useMemo(() => {
    let result = [...data];
    if (search) {
      const lowerSearch = search.toLowerCase();
      result = result.filter(row => Object.values(row).some(val => String(val).toLowerCase().includes(lowerSearch)));
    }
    if (sortConfig) {
      result.sort((a, b) => {
        const valA = a[sortConfig.key] || '';
        const valB = b[sortConfig.key] || '';
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

  const toggleSelectAll = () => {
    if (selectedRows.size === currentData.length) {
      setSelectedRows(new Set());
    } else {
      const newSet = new Set(selectedRows);
      currentData.forEach(row => newSet.add(row['_key']));
      setSelectedRows(newSet);
    }
  };

  const toggleSelectRow = (id: string) => {
    const newSet = new Set(selectedRows);
    if (newSet.has(id)) newSet.delete(id);
    else newSet.add(id);
    setSelectedRows(newSet);
  };

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 flex flex-col h-full">
      <div className="p-4 border-b border-gray-100 flex flex-col sm:flex-row justify-between items-center gap-4">
        <h3 className="font-semibold text-gray-800">{title} <span className="text-gray-500 text-sm font-normal">({processedData.length})</span></h3>
        
        {selectedRows.size > 0 && enableAudit && (
          <div className="flex items-center gap-2 animate-fade-in bg-slate-800 text-white px-3 py-1.5 rounded-md shadow-lg">
             <span className="text-xs font-bold">{selectedRows.size} seleccionados</span>
             <div className="h-4 w-px bg-slate-600 mx-1"></div>
             
             <button 
                onClick={() => { onAutoSmartCheck?.(Array.from(selectedRows)); }} 
                className="text-xs bg-yellow-500 hover:bg-yellow-600 text-black px-2 py-1 rounded font-bold flex items-center gap-1 transition-colors"
                title="Verifica automáticamente si la factura existe en Control y marca OK o ERROR"
             >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                Auto-Analizar
             </button>

             <div className="h-4 w-px bg-slate-600 mx-1"></div>
             <button onClick={() => { onAuditAction?.(Array.from(selectedRows), 'verified'); setSelectedRows(new Set()); }} className="text-xs hover:text-green-300 font-medium flex items-center gap-1">✅ Validar OK</button>
             <button onClick={() => { onAuditAction?.(Array.from(selectedRows), 'failed'); setSelectedRows(new Set()); }} className="text-xs hover:text-red-300 font-medium flex items-center gap-1">❌ Falso Positivo</button>
          </div>
        )}

        <div className="flex gap-2">
           <input type="text" placeholder="Buscar..." className="border rounded-md px-3 py-1.5 text-sm w-full sm:w-64" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>

      <div className="overflow-auto flex-1">
        <table className="min-w-full divide-y divide-gray-200 relative">
          <thead className="bg-gray-50 sticky top-0 z-10 shadow-sm">
            <tr>
              {enableAudit && (
                <th className="px-4 py-3 bg-gray-50 w-10">
                   <input type="checkbox" onChange={toggleSelectAll} checked={selectedRows.size > 0 && selectedRows.size === currentData.length} />
                </th>
              )}
              {enableAudit && <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider bg-gray-50 w-32">Acciones</th>}
              {headers.map(header => (
                <th key={header} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100 select-none whitespace-nowrap" onClick={() => handleSort(header)}>
                  {header} {sortConfig?.key === header && (sortConfig.direction === 'asc' ? '↑' : '↓')}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {currentData.map((row, idx) => {
               const rowId = row['_key'] || `${idx}`; 
               const status = auditState?.[rowId] || 'pending';
               
               return (
                <tr key={idx} className={`hover:bg-gray-50 transition-colors ${status === 'verified' ? 'bg-green-50' : status === 'failed' ? 'bg-red-50' : ''}`}>
                  {enableAudit && (
                    <td className="px-4 py-3">
                       <input type="checkbox" checked={selectedRows.has(rowId)} onChange={() => toggleSelectRow(rowId)} />
                    </td>
                  )}
                  {enableAudit && (
                    <td className="px-4 py-3 whitespace-nowrap text-sm flex items-center gap-1">
                      <button 
                        onClick={() => onAuditAction?.([rowId], 'verified')}
                        title="Manual: Confirmar Discrepancia (Visto Bueno)"
                        className={`p-1.5 rounded-md transition-colors ${status === 'verified' ? 'bg-green-500 text-white' : 'bg-gray-100 text-gray-400 hover:bg-green-100 hover:text-green-600'}`}
                      >
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                      </button>

                      <button 
                        onClick={() => onAuditAction?.([rowId], 'failed')}
                        title="Manual: Marcar Falso Positivo"
                        className={`p-1.5 rounded-md transition-colors ${status === 'failed' ? 'bg-red-500 text-white' : 'bg-gray-100 text-gray-400 hover:bg-red-100 hover:text-red-600'}`}
                      >
                         <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                      </button>

                      <div className="w-px h-5 bg-gray-200 mx-1"></div>

                      <button 
                        onClick={() => onSmartCheck?.(row)} 
                        title="Ver Detalle (3 Vistas)" 
                        className="p-1.5 bg-blue-100 text-blue-600 rounded-md hover:bg-blue-200 transition-colors"
                      >
                         <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                      </button>
                    </td>
                  )}
                  {headers.map((header, hIdx) => (
                    <td key={hIdx} className="px-4 py-3 whitespace-nowrap text-sm text-gray-700">{row[header]}</td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      
      <div className="p-3 border-t border-gray-100 flex justify-between items-center text-sm text-gray-600">
        <span>Página {currentPage} de {totalPages}</span>
        <div className="flex gap-2">
          <button disabled={currentPage === 1} onClick={() => setCurrentPage(p => Math.max(1, p - 1))} className="px-3 py-1 border rounded hover:bg-gray-50 disabled:opacity-50">Anterior</button>
          <button disabled={currentPage === totalPages} onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} className="px-3 py-1 border rounded hover:bg-gray-50 disabled:opacity-50">Siguiente</button>
        </div>
      </div>
    </div>
  );
};

const MonthlyStats = ({ records }: { records: ParsedRow[] }) => {
  const stats = useMemo(() => {
    const grouped: Record<string, { count: number, total: number }> = {};
    records.forEach(r => {
      const dateStr = r['fecha_val'] || '';
      let monthYear = 'Desconocido';
      const parts = dateStr.split(/[-/]/);
      if (parts.length === 3) monthYear = parts[0].length === 4 ? `${parts[0]}-${parts[1]}` : `${parts[2]}-${parts[1]}`;
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

const FileUploader = ({ label, onFileLoaded, fileInfo }: { label: string, onFileLoaded: (f: DataFile) => void, fileInfo: DataFile | null }) => {
  const [isDragOver, setIsDragOver] = useState(false);
  const [loading, setLoading] = useState(false);

  const findHeaderRow = (rows: any[]): number => {
    for (let i = 0; i < Math.min(rows.length, 20); i++) {
      const rowStr = JSON.stringify(rows[i]).toLowerCase();
      let matchCount = 0;
      HEADER_KEYWORDS.forEach(kw => { if (rowStr.includes(kw)) matchCount++; });
      if (matchCount >= 2) return i;
    }
    return 0;
  };

  const processExcel = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: 'array' });
        
        let allData: ParsedRow[] = [];
        let detectedHeaders: string[] = [];

        workbook.SheetNames.forEach((sheetName: string) => {
          const worksheet = workbook.Sheets[sheetName];
          const rawData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
          if (rawData.length === 0) return;

          const headerRowIndex = findHeaderRow(rawData);
          const sheetData: any[] = XLSX.utils.sheet_to_json(worksheet, { 
            range: headerRowIndex, 
            defval: "",
            raw: false,
            dateNF: 'dd/mm/yyyy'
          });
          
          if (sheetData.length > 0) {
            const standardized: ParsedRow[] = sheetData.map(row => {
               const newRow: ParsedRow = {};
               Object.keys(row).forEach(key => {
                 newRow[key] = String(row[key] !== undefined && row[key] !== null ? row[key] : "").trim();
               });
               return newRow;
            });
            
            allData = [...allData, ...standardized];
            if (detectedHeaders.length === 0 && sheetData.length > 0) {
              detectedHeaders = Object.keys(sheetData[0]);
            }
          }
        });
        
        if (allData.length === 0) {
          alert("El archivo Excel parece estar vacío o no se detectaron datos válidos.");
          setLoading(false);
          return;
        }

        onFileLoaded({
          name: file.name,
          data: allData,
          headers: detectedHeaders
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
    if (!file) return;
    setLoading(true);

    const fileName = file.name.toLowerCase();
    if (fileName.endsWith('.csv')) {
      processCSV(file);
    } else if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
      processExcel(file);
    } else {
      alert("Formato no soportado. Use archivos .csv o .xlsx");
      setLoading(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files?.[0]) handleFile(e.dataTransfer.files[0]);
  };

  return (
    <div>
      {!fileInfo ? (
        <div
          onDrop={handleDrop}
          onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
          onDragLeave={() => setIsDragOver(false)}
          className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer hover:border-blue-400 transition-colors ${isDragOver ? 'drag-active' : 'border-gray-300'}`}
          onClick={() => document.getElementById(`file-input-${label}`)?.click()}
        >
          {loading ? (
            <div className="flex flex-col items-center">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mb-3"></div>
              <p className="text-gray-500 text-sm">Procesando archivo...</p>
            </div>
          ) : (
            <>
              <svg className="w-12 h-12 mx-auto text-gray-400 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" /></svg>
              <p className="text-gray-600 font-medium mb-1">{label}</p>
              <p className="text-xs text-gray-500">Arrastra o haz clic para seleccionar (.csv .xlsx)</p>
            </>
          )}
          <input id={`file-input-${label}`} type="file" accept=".csv,.xlsx,.xls" className="hidden" onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])} />
        </div>
      ) : (
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <svg className="w-8 h-8 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
              <div>
                <p className="font-medium text-gray-800 text-sm">{fileInfo.name}</p>
                <p className="text-xs text-gray-500">{fileInfo.data.length} registros cargados</p>
              </div>
            </div>
            <button onClick={() => onFileLoaded(null!)} className="text-red-500 hover:text-red-700">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

const ColumnMapper = ({ headers, mapping, setMapping }: { headers: string[], mapping: Record<string, string>, setMapping: (m: Record<string, string>) => void }) => {
  const handleChange = (reqKey: string, selectedHeader: string) => {
    setMapping({ ...mapping, [reqKey]: selectedHeader });
  };

  const allMapped = REQUIRED_FIELDS.every(field => mapping[field.key]);

  return (
    <div className="space-y-3">
      {REQUIRED_FIELDS.map(field => (
        <div key={field.key} className="grid grid-cols-2 gap-3 items-center">
          <label className="text-sm text-gray-700">{field.label}</label>
          <select value={mapping[field.key] || ''} onChange={(e) => handleChange(field.key, e.target.value)} className="border rounded px-2 py-1.5 text-sm">
            <option value="">-- Seleccionar columna --</option>
            {headers.map(h => <option key={h} value={h}>{h}</option>)}
          </select>
        </div>
      ))}
      {!allMapped && <p className="text-xs text-amber-600 bg-amber-50 px-2 py-1.5 rounded border border-amber-200">⚠️ Completa todos los mapeos para continuar</p>}
      {allMapped && <p className="text-xs text-green-600 bg-green-50 px-2 py-1.5 rounded border border-green-200">✅ Mapeo completo</p>}
    </div>
  );
};

const DiscrepancyReport = ({ 
  result, 
  schoolName, 
  auditState, 
  setAuditState, 
  onDeepLink, 
  onClearData 
}: { 
  result: AnalysisResult, 
  schoolName: string, 
  auditState: Record<string, AuditStatus>, 
  setAuditState: (s: Record<string, AuditStatus>) => void, 
  onDeepLink: (target: 'softland' | 'control', query: string) => void, 
  onClearData: () => void 
}) => {
  const [modalRecord, setModalRecord] = useState<ParsedRow | null>(null);

  const verified = Object.values(auditState).filter(s => s === 'verified').length;
  const failed = Object.values(auditState).filter(s => s === 'failed').length;
  const realMissing = result.missingCount - failed;
  const realMissingAmount = result.missingRecords.filter(r => auditState[r['_key']] !== 'failed').reduce((sum, r) => sum + parseAmount(r['monto_val']), 0);

  const handleAuditAction = (ids: string[], status: AuditStatus) => {
    const newState = { ...auditState };
    ids.forEach(id => { newState[id] = status; });
    setAuditState(newState);
  };

  const handleBulkAutoCheck = (ids: string[]) => {
    const newState = { ...auditState };
    const controlKeys = new Set(result.controlRecords.map(r => r['_key']));

    ids.forEach(id => {
      const record = result.missingRecords.find(r => r['_key'] === id);
      if (!record) return;
      
      const targetInv = normalizeInvoice(record['factura_val']);
      const found = result.controlRecords.some(c => normalizeInvoice(c['factura_val']) === targetInv);
      newState[id] = found ? 'failed' : 'verified';
    });

    setAuditState(newState);
  };

  const exportToExcel = async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Discrepancias');

    sheet.columns = [
      { header: 'Fecha', key: 'fecha_val', width: 12 },
      { header: 'N° Factura', key: 'factura_val', width: 15 },
      { header: 'RUT', key: 'rut_val', width: 15 },
      { header: 'Nombre Proveedor', key: 'nombre_val', width: 40 },
      { header: 'Monto', key: 'monto_val', width: 15 }
    ];

    result.missingRecords.forEach(r => {
      sheet.addRow({
        fecha_val: r['fecha_val'],
        factura_val: r['factura_val'],
        rut_val: r['rut_val'],
        nombre_val: r['nombre_val'],
        monto_val: r['monto_val']
      });
    });

    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2EFDA' } };

    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Discrepancias_${schoolName}_${new Date().toISOString().split('T')[0]}.xlsx`;
    a.click();
  };

  return (
    <div className="animate-fade-in-up">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <div className="bg-gradient-to-br from-slate-50 to-slate-100 p-6 rounded-lg shadow-sm border border-slate-200">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-slate-600 font-medium">DISCREPANCIAS INICIALES</span>
            <span className="text-xs bg-slate-200 text-slate-700 px-2 py-1 rounded-full font-bold">Cruce algoritmo</span>
          </div>
          <div className="text-3xl font-bold text-slate-800">{result.missingCount}</div>
          <div className="text-sm text-slate-500 mt-1">${result.missingAmount.toLocaleString('es-CL')}</div>
        </div>

        <div className="bg-gradient-to-br from-green-50 to-green-100 p-6 rounded-lg shadow-sm border border-green-200">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-green-700 font-medium">✅ FALTANTES REALES</span>
            <span className="text-xs bg-green-200 text-green-800 px-2 py-1 rounded-full font-bold">Confirmados</span>
          </div>
          <div className="text-3xl font-bold text-green-900">{verified}</div>
          <div className="text-sm text-green-600 mt-1">Validado manualmente</div>
        </div>

        <div className="bg-gradient-to-br from-red-50 to-red-100 p-6 rounded-lg shadow-sm border border-red-200">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-red-700 font-medium">❌ FALSOS POSITIVOS</span>
            <span className="text-xs bg-red-200 text-red-800 px-2 py-1 rounded-full font-bold">Descartados</span>
          </div>
          <div className="text-3xl font-bold text-red-900">{failed}</div>
          <div className="text-sm text-red-600 mt-1">Excluir del reporte</div>
        </div>

        <div className="bg-gradient-to-br from-blue-50 to-blue-100 p-6 rounded-lg shadow-sm border border-blue-200">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-blue-700 font-medium uppercase">MONTO REAL FALTANTE</span>
            <span className="text-xs bg-blue-200 text-blue-800 px-2 py-1 rounded-full font-bold">Excluye descartados</span>
          </div>
          <div className="text-2xl font-bold text-blue-900">${realMissingAmount.toLocaleString('es-CL')}</div>
          <div className="text-sm text-blue-600 mt-1">{realMissing} registros válidos</div>
        </div>
      </div>

      <div className="bg-white p-4 rounded-lg shadow-sm border border-gray-200 mb-6">
        <h3 className="font-semibold text-gray-800 mb-3">Módulo de Auditoría y Validación</h3>
        <div className="flex gap-3">
          <button onClick={onClearData} className="px-4 py-2 bg-white border border-red-200 text-red-600 rounded-lg hover:bg-red-50 flex items-center gap-2 text-sm">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
            Limpiar / Nuevo
          </button>
          <button onClick={exportToExcel} className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 flex items-center gap-2 text-sm shadow-md">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
            Exportar Excel
          </button>
          <button className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 flex items-center gap-2 text-sm shadow-md">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" /></svg>
            Informe IA
          </button>
        </div>
      </div>

      <MonthlyStats records={result.missingRecords} />

      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
        <h3 className="font-semibold text-gray-800 mb-4 flex items-center gap-2">
          <svg className="w-5 h-5 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
          Estadísticas por Mes (Faltantes)
        </h3>
      </div>

      <div className="h-[calc(100vh-450px)] mb-6">
        <DataTable 
          data={result.missingRecords} 
          headers={['fecha_val', 'factura_val', 'rut_val', 'nombre_val', 'monto_val']} 
          title="Registro de Discrepancias" 
          enableAudit={true} 
          auditState={auditState} 
          onAuditAction={handleAuditAction} 
          onSmartCheck={setModalRecord} 
          onAutoSmartCheck={handleBulkAutoCheck}
        />
      </div>
      {modalRecord && (
        <ComparisonModal 
          record={modalRecord} 
          controlData={result.controlRecords} 
          onClose={() => setModalRecord(null)} 
          onMarkStatus={(status) => handleAuditAction([modalRecord['_key']], status)}
        />
      )}
    </div>
  );
};

const App = () => {
  const [selectedSchool, setSelectedSchool] = useState(SCHOOLS[0].id);
  // Centralized State for ALL schools
  const [allSchoolsData, setAllSchoolsData] = useState<Record<string, SchoolState>>({
      'panguipulli': { ...INITIAL_SCHOOL_STATE },
      'pullinque': { ...INITIAL_SCHOOL_STATE }
  });

  const currentSchoolName = SCHOOLS.find(s => s.id === selectedSchool)?.name || '';
  
  // Helper to access current school state safely
  const currentData = allSchoolsData[selectedSchool];

  // Helper to update current school state
  const updateCurrentSchool = (updates: Partial<SchoolState>) => {
      setAllSchoolsData(prev => ({
          ...prev,
          [selectedSchool]: { ...prev[selectedSchool], ...updates }
      }));
  };

  const handleClearData = () => {
      if (confirm("¿Está seguro de querer limpiar todos los datos y cargas para este colegio?")) {
          updateCurrentSchool({ ...INITIAL_SCHOOL_STATE });
      }
  };

  // ============================================================
  // FUNCIÓN runAnalysis MEJORADA CON VALIDACIÓN ROBUSTA
  // ============================================================
  const runAnalysis = () => {
    if (!currentData.softlandFile || !currentData.controlFile) return;
    
    const processRows = (rows: ParsedRow[], mapping: Record<string, string>, source: 'softland' | 'control') => {
      console.log(`[${source.toUpperCase()}] Procesando ${rows.length} filas crudas...`);
      
      const processed = rows
        .map((row, idx) => ({
          ...row,
          factura_val: row[mapping['factura']] || '',
          rut_val: row[mapping['rut']] || '',
          monto_val: parseAmount(row[mapping['monto']] || '0').toString(),
          nombre_val: row[mapping['nombre']] || '',
          fecha_val: row[mapping['fecha']] || '',
          tipo_val: row[mapping['tipo']] || '',
          _key: `${normalizeRut(row[mapping['rut']])}_${normalizeInvoice(row[mapping['factura']])}`,
          _originalIndex: idx
        }))
        .filter(r => isValidDataRow(r, {
          factura: 'factura_val',
          rut: 'rut_val',
          monto: 'monto_val',
          nombre: 'nombre_val',
          fecha: 'fecha_val',
          tipo: 'tipo_val'
        }));
      
      console.log(`[${source.toUpperCase()}] ✓ ${processed.length} filas válidas después de filtrado`);
      console.log(`[${source.toUpperCase()}] ✗ ${rows.length - processed.length} filas eliminadas (basura/subtotales/NC)`);
      
      return processed;
    };

    const softlandProcessed = processRows(currentData.softlandFile.data, currentData.softlandMapping, 'softland');
    const controlProcessed = processRows(currentData.controlFile.data, currentData.controlMapping, 'control');
    
    const controlKeys = new Set(controlProcessed.map(r => r._key));
    const missingRecords = softlandProcessed.filter(sRow => !controlKeys.has(sRow._key));
    const totalMissingAmount = missingRecords.reduce((sum, r) => sum + parseInt(r.monto_val), 0);
    
    console.log('\n=== RESUMEN ANÁLISIS ===');
    console.log(`Softland válidos:  ${softlandProcessed.length}`);
    console.log(`Control válidos:   ${controlProcessed.length}`);
    console.log(`Coincidencias:     ${softlandProcessed.length - missingRecords.length}`);
    console.log(`Faltantes:         ${missingRecords.length}`);
    console.log(`Monto faltante:    $${(totalMissingAmount / 1000000).toFixed(1)}M`);
    
    updateCurrentSchool({
        analysis: {
            softlandTotal: softlandProcessed.length,
            controlTotal: controlProcessed.length,
            matchedCount: softlandProcessed.length - missingRecords.length,
            missingCount: missingRecords.length,
            missingAmount: totalMissingAmount,
            missingRecords,
            controlRecords: controlProcessed,
            softlandRecords: softlandProcessed
        }
    });
  };

  const handleDeepLink = (target: 'softland' | 'control', query: string) => { 
      updateCurrentSchool({
          [target === 'softland' ? 'softlandSearch' : 'controlSearch']: query,
          activeTab: target
      });
  };

  return (
    <div className="min-h-screen flex flex-col md:flex-row bg-slate-50">
      <aside className="w-full md:w-64 bg-slate-900 text-white flex-shrink-0 flex flex-col h-screen sticky top-0">
        <div className="p-6">
          <h1 className="text-xl font-bold text-slate-100 flex items-center gap-2">
             <svg className="w-6 h-6 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
             AuditMaster
          </h1>
          <p className="text-xs text-slate-400 mt-1">Conciliación Contable</p>
        </div>
        <nav className="mt-4 px-2 flex-1">
          <div className="mb-4"><p className="px-4 text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Entidad</p>{SCHOOLS.map(school => (<button key={school.id} onClick={() => setSelectedSchool(school.id)} className={`w-full text-left px-4 py-2 rounded-md mb-1 text-sm transition-colors ${selectedSchool === school.id ? 'bg-blue-600 text-white shadow-md' : 'text-slate-300 hover:bg-slate-800'}`}>{school.name}</button>))}</div>
          {currentData.analysis && (<div><p className="px-4 text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Vistas</p>
            <button onClick={() => updateCurrentSchool({activeTab: 'dashboard'})} className={`w-full text-left px-4 py-2 rounded-md mb-1 text-sm flex items-center gap-2 ${currentData.activeTab === 'dashboard' ? 'bg-slate-800 text-white' : 'text-slate-300 hover:bg-slate-800'}`}>Resultados</button>
            <button onClick={() => updateCurrentSchool({activeTab: 'softland'})} className={`w-full text-left px-4 py-2 rounded-md mb-1 text-sm flex items-center gap-2 ${currentData.activeTab === 'softland' ? 'bg-slate-800 text-white' : 'text-slate-300 hover:bg-slate-800'}`}>Base Softland</button>
            <button onClick={() => updateCurrentSchool({activeTab: 'control'})} className={`w-full text-left px-4 py-2 rounded-md mb-1 text-sm flex items-center gap-2 ${currentData.activeTab === 'control' ? 'bg-slate-800 text-white' : 'text-slate-300 hover:bg-slate-800'}`}>Base Control</button>
          </div>)}
        </nav>
      </aside>
      <main className="flex-1 p-8 overflow-y-auto max-h-screen">
        <div className="max-w-[1400px] mx-auto">
          <header className="mb-6"><h2 className="text-2xl font-bold text-gray-800">{currentSchoolName}</h2><p className="text-gray-500">{currentData.analysis ? 'Panel de Auditoría Activo' : 'Cargue los archivos para comenzar'}</p></header>
          {!currentData.analysis && (
            <><section className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
                <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200"><div className="flex items-center gap-2 mb-4"><div className="w-3 h-3 rounded-full bg-blue-500"></div><h3 className="font-semibold text-gray-800">1. Maestro Softland</h3></div><FileUploader label="Cargar Softland" fileInfo={currentData.softlandFile} onFileLoaded={(f) => updateCurrentSchool({softlandFile: f})} />{currentData.softlandFile && (<div className="mt-4"><h4 className="text-xs font-semibold text-gray-500 uppercase mb-2">Mapeo de Columnas</h4><ColumnMapper headers={currentData.softlandFile.headers} mapping={currentData.softlandMapping} setMapping={(m) => updateCurrentSchool({softlandMapping: m})} /></div>)}</div>
                <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200"><div className="flex items-center gap-2 mb-4"><div className="w-3 h-3 rounded-full bg-green-500"></div><h3 className="font-semibold text-gray-800">2. Control Presupuesto</h3></div><FileUploader label="Cargar Control" fileInfo={currentData.controlFile} onFileLoaded={(f) => updateCurrentSchool({controlFile: f})} />{currentData.controlFile && (<div className="mt-4"><h4 className="text-xs font-semibold text-gray-500 uppercase mb-2">Mapeo de Columnas</h4><ColumnMapper headers={currentData.controlFile.headers} mapping={currentData.controlMapping} setMapping={(m) => updateCurrentSchool({controlMapping: m})} /></div>)}</div>
              </section>
              <div className="flex justify-center mb-8"><button onClick={runAnalysis} disabled={!currentData.softlandFile || !currentData.controlFile} className="bg-slate-900 text-white px-8 py-3 rounded-lg font-semibold shadow-lg hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transform transition active:scale-95">Realizar Cruce de Información</button></div>
            </>
          )}
          {currentData.analysis && currentData.activeTab === 'dashboard' && (
             <DiscrepancyReport 
                result={currentData.analysis} 
                schoolName={currentSchoolName} 
                auditState={currentData.auditState} 
                setAuditState={(s) => updateCurrentSchool({auditState: s})} 
                onDeepLink={handleDeepLink} 
                onClearData={handleClearData}
             />
          )}
          {currentData.analysis && currentData.activeTab === 'softland' && currentData.softlandFile && (<div className="h-[calc(100vh-150px)] animate-fade-in-up"><DataTable data={currentData.softlandFile.data} headers={currentData.softlandFile.headers} title="Base de Datos Completa - Softland" initialSearch={currentData.softlandSearch} /></div>)}
          {currentData.analysis && currentData.activeTab === 'control' && currentData.controlFile && (<div className="h-[calc(100vh-150px)] animate-fade-in-up"><DataTable data={currentData.controlFile.data} headers={currentData.controlFile.headers} title="Base de Datos Completa - Control Presupuestario" initialSearch={currentData.controlSearch} /></div>)}
        </div>
      </main>
    </div>
  );
};

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
