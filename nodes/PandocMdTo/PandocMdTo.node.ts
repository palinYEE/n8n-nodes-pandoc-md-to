import {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IBinaryKeyData,
	NodeOperationError,
} from 'n8n-workflow';
import { writeFile, readFile, unlink, rmdir } from 'fs/promises';
import { join } from 'path';
import { v5 as uuidv5 } from 'uuid';
import { exec as execCallback } from 'child_process';
import { existsSync } from 'fs';
import { promisify } from 'util';

const exec = promisify(execCallback);

// Create a namespace UUID for our application (using v4 for the namespace is fine as it's constant)
const NAMESPACE_UUID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'; // UUID namespace for URLs (standard namespace)

interface PandocError extends Error {
	code?: string;
	stdout?: string;
	stderr?: string;
}

export class PandocMdTo implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Pandoc Md To',
		name: 'pandocMdTo',
		icon: 'file:PandocMdTo.svg',
		group: ['transform'],
		version: 1,
		description: 'Pandoc Markdown to PDF or docx',
		defaults: {
			name: 'Pandoc Md To',
		},
		inputs: ['main'],
		outputs: ['main'],
		properties: [
			{
				displayName: 'Binary Property',
				name: 'binaryPropertyName',
				type: 'string',
				default: 'data',
				description: 'Name of the binary property that contains the file to convert',
			},
			{
				displayName: 'To Format',
				name: 'toFormat',
				type: 'options',
				options: [
					{
						name: 'PDF',
						value: 'pdf',
					},
				],
				default: 'pdf',
				description: 'Output format for the document',
			},
		],
	};

	private static getMimeType(format: string): string {
		const mimeTypes: Record<string, string> = {
			pdf: 'application/pdf',
			docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
			html: 'text/html',
			markdown: 'text/markdown',
			latex: 'application/x-latex',
			plain: 'text/plain',
		};
		return mimeTypes[format] || 'application/octet-stream';
	}

	private static getFileName(originalName: string, newFormat: string): string {
		const baseName = originalName.split('.').slice(0, -1).join('.');
		return `${baseName}.${PandocMdTo.getFileExtension(newFormat)}`;
	}

	private static getFileExtension(format: string): string {
		const extensions: Record<string, string> = {
			pdf: 'pdf',
			docx: 'docx',
			html: 'html',
			markdown: 'md',
			latex: 'tex',
			plain: 'txt',
		};
		return extensions[format] || format;
	}

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const imageData: INodeExecutionData[] = [];

		const cleanupFiles = async (paths: string[]): Promise<void> => {
			await Promise.all(
				paths.map(async (path) => {
					try {
						const stat = await import('fs/promises').then((fs) => fs.stat(path));
						if (stat.isDirectory()) {
							await rmdir(path, { recursive: true });
						} else {
							await unlink(path);
						}
					} catch (error) {
						// Ignore cleanup errors
					}
				}),
			);
		};

		for (let i = 0; i < items.length; i++) {
			const tempPaths: string[] = [];
			try {
				const binaryPropertyName = this.getNodeParameter('binaryPropertyName', i) as string;
				const toFormat = this.getNodeParameter('toFormat', i) as string;

				const binaryData = items[i].binary?.[binaryPropertyName];
				console.log('test', binaryData);
				if (!binaryData) {
					throw new NodeOperationError(
						this.getNode(),
						`No binary data found in property "${binaryPropertyName}"`,
					);
				}

				// Generate deterministic UUID based on the input filename
				const tempId = uuidv5(binaryData.fileName || 'unnamed', NAMESPACE_UUID);

				// Create temporary file paths
				const tempDir = './';
				const inputPath = join(tempDir, `pandoc_input_${tempId}.md`);
				const outputPath = join(tempDir, `pandoc_output_${tempId}`);

				// tempPaths.push(inputPath);
				tempPaths.push(outputPath);

				// Write input file
				const buffer = Buffer.from(binaryData.data, 'base64');
				await writeFile(inputPath, buffer);

				// Build pandoc arguments
				const args = [
					inputPath,
					'--from',
					'markdown',
					'--to',
					toFormat,
					'--output',
					outputPath,
					'--template',
					'eisvogel',
				];

				// command 실행
				const command = `pandoc ${args.join(' ')}`;
				const { stderr: stderr } = await exec(command);
				if (stderr) {
					throw new NodeOperationError(this.getNode(), `Pandoc error: ${stderr}`);
				}

				// Read output file
				// 파일 존재하는지 확인
				if (!existsSync(outputPath)) {
					throw new NodeOperationError(this.getNode(), 'Output file does not exist');
				}

				const outputContent = await readFile(outputPath);

				// Create the new binary data for the main output
				const newBinaryData: IBinaryKeyData = {
					[binaryPropertyName]: {
						data: outputContent.toString('base64'),
						mimeType: PandocMdTo.getMimeType(toFormat),
						fileName: PandocMdTo.getFileName(binaryData.fileName || 'document', toFormat),
					},
				};

				returnData.push({
					json: items[i].json,
					binary: newBinaryData,
				});
			} catch (error) {
				const pandocError = error as PandocError;
				if (this.continueOnFail()) {
					returnData.push({
						json: {
							error: pandocError.message,
							code: pandocError.code,
							stdout: pandocError.stdout,
							stderr: pandocError.stderr,
						},
						binary: {},
					});
					continue;
				}
				throw error;
			} finally {
				// Clean up temporary files
				await cleanupFiles(tempPaths);
			}
		}

		return [returnData, imageData];
	}
}
