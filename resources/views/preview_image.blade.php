@extends('layouts.index')

@section('scripts')
    <script>
        const file = {!! json_encode($file) !!};
    </script>
@endsection

@section('content')
    <div id="file_preview_dashboard"></div>
    <img src="{{url("/api")}}?path={{$file->getNative()->getRealPath()}}"
         style="width: 70%; margin: auto; text-align: center;">
    <br/>
@endsection
