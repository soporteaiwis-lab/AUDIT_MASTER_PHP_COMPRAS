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

// ========== NUEVA FUNCIÓN DE VALIDACIÓN ROBUSTA ==========
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

// ========== FIN DE NUEVA FUNCIÓN ==========

// [RESTO DEL CÓDIGO ORIGINAL SE MANTIENE IGUAL HASTA runAnalysis]
// ... (incluir todos los componentes anteriores aquí) ...

// MODIFICAR SOLO LA FUNCIÓN runAnalysis:

const runAnalysis = () => {
    if (!currentData.softlandFile || !currentData.controlFile) return;
    
    // === VERSIÓN MEJORADA DE processRows ===
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
      
      console.log(`[${source.toUpperCase()}] ${processed.length} filas válidas después de filtrado`);
      console.log(`[${source.toUpperCase()}] ${rows.length - processed.length} filas eliminadas (basura/subtotales/NC)`);
      
      return processed;
    };

    const softlandProcessed = processRows(currentData.softlandFile.data, currentData.softlandMapping, 'softland');
    const controlProcessed = processRows(currentData.controlFile.data, currentData.controlMapping, 'control');
    
    const controlKeys = new Set(controlProcessed.map(r => r._key));
    const missingRecords = softlandProcessed.filter(sRow => !controlKeys.has(sRow._key));
    const totalMissingAmount = missingRecords.reduce((sum, r) => sum + parseInt(r.monto_val), 0);
    
    console.log('=== RESUMEN ANÁLISIS ===');
    console.log(`Softland: ${softlandProcessed.length} registros válidos`);
    console.log(`Control: ${controlProcessed.length} registros válidos`);
    console.log(`Coincidencias: ${softlandProcessed.length - missingRecords.length}`);
    console.log(`Faltantes: ${missingRecords.length} (${(totalMissingAmount / 1000000).toFixed(1)}M)`);
    
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

// [RESTO DEL CÓDIGO SE MANTIENE IGUAL]
