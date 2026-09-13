import { AutoModel, AutoProcessor, RawImage, Tensor, env } from '@huggingface/transformers';
import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
env.cacheDir = './node_modules/.cache/transformers';
const sourcePath = process.argv[2] ?? '/tmp/pixelstretch-piza.jpg';
await mkdir('artifacts/segmentation', { recursive: true });
const image = await RawImage.read(sourcePath);
for (const [name, id] of [['rmbg', 'briaai/RMBG-1.4'], ['birefnet', 'studioludens/birefnet-lite-512']]) {
  console.log('Loading', id);
  const model = await AutoModel.from_pretrained(id, { dtype: 'fp32', device: 'cpu', ...(name === 'rmbg' ? {config:{model_type:'custom'}} : {}) });
  console.time(name);
  let mask;
  if (name === 'rmbg') {
    const resized = await image.clone().rgb().resize(1024,1024);
    const plane = 1024*1024, data = new Float32Array(3*plane);
    for(let i=0;i<plane;i++) for(let c=0;c<3;c++) data[c*plane+i]=resized.data[i*3+c]/255-.5;
    const output = await model({ input:new Tensor('float32',data,[1,3,1024,1024]) });
    const tensor = output.output ?? Object.values(output)[0];
    let min=Infinity,max=-Infinity; for(const v of tensor.data) {min=Math.min(min,v);max=Math.max(max,v);}
    mask = new RawImage(Uint8ClampedArray.from(tensor.data,v=>255*(v-min)/(max-min)),1024,1024,1);
  } else {
    const processor = await AutoProcessor.from_pretrained(id);
    const {pixel_values} = await processor(image.clone().rgb());
    const output = await model({input_image:pixel_values});
    const tensor = output.logits ?? Object.values(output)[0];
    const [h,w] = tensor.dims.slice(-2);
    mask = new RawImage(Uint8ClampedArray.from(tensor.data,v=>255/(1+Math.exp(-v))),w,h,1);
  }
  console.timeEnd(name);
  await mask.save(`artifacts/segmentation/${name}-mask.png`);
  const base = await sharp(sourcePath).rotate().resize({height:1350}).removeAlpha().raw().toBuffer({resolveWithObject:true});
  const alpha = await sharp(mask.data,{raw:{width:mask.width,height:mask.height,channels:1}}).resize(base.info.width,base.info.height,{fit:'fill'}).greyscale().raw().toBuffer();
  const rgba = Buffer.alloc(base.info.width * base.info.height * 4);
  for (let i=0; i<alpha.length; i++) {
    rgba.set(base.data.subarray(i*3, i*3+3), i*4);
    rgba[i*4+3] = alpha[i];
  }
  await sharp(rgba,{raw:{width:base.info.width,height:base.info.height,channels:4}}).png().toFile(`artifacts/segmentation/${name}-cutout.png`);
  await sharp(`artifacts/segmentation/${name}-cutout.png`).flatten({background:'#fff'}).toFile(`artifacts/segmentation/${name}-preview.png`);
  await model.dispose();
}
await writeFile('artifacts/segmentation/model-comparison.txt','Input: piza.HEIC converted locally with macOS sips. Models run using Transformers.js fp32 CPU. Reference is separately cropped/scaled; compare silhouettes visually.\n');
