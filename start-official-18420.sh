#!/bin/bash
# A/B 实验：官方 vLLM 0.30.0 栈跑 Qwen3.8-Flash-Next W4A16（宿主 venv，非 chroot）
# 参数对齐生产定制栈（18420），差异仅在引擎来源。回滚=ab-restore-custom.sh
SP=/home/ll/vllm-env/lib/python3.11/site-packages
MODEL=/media/ll/data/models-1m/Qwen3.8-Flash-Next-W4A16-AutoRound-1M
LOG=/home/ll/deploy/vllm-official-18420.log

export VLLM_ALLOW_LONG_MAX_MODEL_LEN=1
export CUDA_HOME=$SP/nvidia/cu13
export PATH=$CUDA_HOME/bin:$PATH
export FLASHINFER_EXTRA_CUDAFLAGS=-DCCCL_DISABLE_CTK_COMPATIBILITY_CHECK
export FLASHINFER_DISABLE_VERSION_CHECK=1
export VLLM_CACHE_ROOT=/home/ll/.cache/vllm-18420-official
export VLLM_WORKER_MULTIPROC_METHOD=spawn
# NCCL 对齐生产 inner（0919 定版：P2P 走 PHB 放行）
export NCCL_P2P_LEVEL=PHB
export NCCL_SHM_DISABLE=0
export NCCL_CUMEM_ENABLE=0
export NCCL_NET_GDR_LEVEL=0
# 官方 PLE CPU offload（=EngramConfig.cpu_offload，缺省已开，显式钉住）
export VLLM_PLE_CPU_OFFLOAD=1

exec /home/ll/vllm-env/bin/vllm serve "$MODEL" \
  --served-model-name qwen3.8-flash-next --host 0.0.0.0 --port 18420 \
  --distributed-executor-backend mp --tensor-parallel-size 1 --pipeline-parallel-size 2 \
  --dtype bfloat16 --max-model-len 1048576 --block-size 1616 --mamba-ssm-cache-dtype float32 \
  --max-num-seqs 3 --gpu-memory-utilization 0.95 \
  --enable-prefix-caching --enable-prompt-tokens-details \
  --max-num-batched-tokens 8192 --moe-backend auto \
  --reasoning-parser qwen3 --enable-auto-tool-choice --tool-call-parser qwen3_coder \
  --trust-remote-code --safetensors-load-strategy lazy \
  --default-chat-template-kwargs '{"enable_thinking":true,"preserve_thinking":true}' \
  --override-generation-config '{"temperature":0.6,"top_p":0.95,"top_k":20,"min_p":0.0,"presence_penalty":0.1,"repetition_penalty":1.05}' \
  -cc.cudagraph_mode=FULL_AND_PIECEWISE \
  -cc.cudagraph_capture_sizes='[1,2,4,8,16,24,32,40]' \
  -cc.inductor_compile_config='{"combo_kernels":false,"benchmark_combo_kernel":false}' \
  --no-enable-flashinfer-autotune \
  --async-scheduling \
  --speculative-config '{"method":"mtp","num_speculative_tokens":4,"use_local_argmax_reduction":false}' \
  --engram-config '{"cpu_offload":true}' \
  >> "$LOG" 2>&1
